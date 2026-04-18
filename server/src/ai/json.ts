/**
 * JSON-mode helper for all three providers. Every call records usage if a
 * userId is supplied.
 */
import { env } from "../env.js";
import type { AiProvider } from "@app/shared";
import { recordUsage, refundCredits, reserveCredits } from "../usage/tracker.js";
import { tokensToCredits } from "../billing/packs.js";
import type { UserKeys } from "./user-keys.js";

const MODELS: Record<AiProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-5",
  deepseek: "deepseek-chat",
};

export async function aiJson<T = unknown>(
  provider: AiProvider,
  systemPrompt: string,
  userPrompt: string,
  opts: { maxTokens?: number; userId?: string; userKeys?: UserKeys } = {},
): Promise<T> {
  const maxTokens = opts.maxTokens ?? 3000;
  const model = MODELS[provider];

  const userKey =
    provider === "openai" ? opts.userKeys?.openai :
    provider === "anthropic" ? opts.userKeys?.anthropic :
    opts.userKeys?.deepseek;
  const envKey =
    provider === "openai" ? env.OPENAI_API_KEY :
    provider === "anthropic" ? env.ANTHROPIC_API_KEY :
    env.DEEPSEEK_API_KEY;
  const apiKey = userKey ?? envKey;
  const byok = !!userKey;
  const chargeUserId = byok ? undefined : opts.userId;

  const estInput = Math.ceil((systemPrompt.length + userPrompt.length) / 4);
  const reserved = tokensToCredits(estInput + maxTokens);
  if (chargeUserId) await reserveCredits(chargeUserId, reserved);

  let raw = "";
  let inputTokens = 0;
  let outputTokens = 0;

  if (provider === "anthropic") {
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: `${systemPrompt}\n\nReturn valid JSON only. No prose, no markdown fences.`,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${await r.text()}`);
    const data = (await r.json()) as {
      content: Array<{ type: string; text?: string }>;
      usage: { input_tokens: number; output_tokens: number };
    };
    raw = data.content.map((c) => c.text ?? "").join("").trim();
    inputTokens = data.usage.input_tokens ?? 0;
    outputTokens = data.usage.output_tokens ?? 0;
  } else {
    if (!apiKey) throw new Error(`${provider.toUpperCase()}_API_KEY not set`);
    const baseUrl = provider === "deepseek" ? "https://api.deepseek.com" : "https://api.openai.com";

    const r = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `${systemPrompt}\nReturn a JSON object.` },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!r.ok) throw new Error(`${provider} ${r.status}: ${await r.text()}`);
    const data = (await r.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    raw = data.choices[0]?.message.content ?? "";
    inputTokens = data.usage.prompt_tokens ?? 0;
    outputTokens = data.usage.completion_tokens ?? 0;
  }

  if (chargeUserId) {
    const actual = tokensToCredits(inputTokens + outputTokens);
    if (reserved > actual) await refundCredits(chargeUserId, reserved - actual);
    await recordUsage({
      userId: chargeUserId, provider, kind: "json",
      inputTokens, outputTokens, metadata: { model },
    });
  }

  return parseJson<T>(raw);
}

function parseJson<T>(raw: string): T {
  const cleaned = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const m = cleaned.match(/[[{][\s\S]*[\]}]/);
    if (m) return JSON.parse(m[0]) as T;
    throw new Error(`AI returned non-JSON: ${cleaned.slice(0, 200)}`);
  }
}
