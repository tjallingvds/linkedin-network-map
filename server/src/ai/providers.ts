/**
 * Server-side AI providers. API keys live in env only. Every call records a
 * usage event (input/output tokens, cost) for the active user.
 */
import { env } from "../env.js";
import type { AiProvider } from "@app/shared";
import { recordUsage, refundCredits, reserveCredits } from "../usage/tracker.js";
import { tokensToCredits } from "../billing/packs.js";

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiCallResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  provider: AiProvider;
  model: string;
}

const MODELS: Record<AiProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-5",
  deepseek: "deepseek-chat",
};

export function hasKey(provider: AiProvider): boolean {
  switch (provider) {
    case "openai":
      return !!env.OPENAI_API_KEY;
    case "anthropic":
      return !!env.ANTHROPIC_API_KEY;
    case "deepseek":
      return !!env.DEEPSEEK_API_KEY;
  }
}

export function availableProviders(): AiProvider[] {
  return (["openai", "anthropic", "deepseek"] as AiProvider[]).filter(hasKey);
}

export async function aiChat(
  provider: AiProvider,
  messages: AiMessage[],
  opts: { maxTokens?: number; temperature?: number; userId?: string } = {},
): Promise<AiCallResult> {
  const maxTokens = opts.maxTokens ?? 2048;
  const temperature = opts.temperature ?? 0.2;
  const model = MODELS[provider];

  // Reserve a conservative upper bound: prompt length + max output tokens.
  const estInput = Math.ceil(messages.reduce((a, m) => a + m.content.length, 0) / 4);
  const reserved = tokensToCredits(estInput + maxTokens);
  if (opts.userId) await reserveCredits(opts.userId, reserved);

  let result: AiCallResult;

  if (provider === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const convo = messages.filter((m) => m.role !== "system");

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        system: system || undefined,
        messages: convo,
      }),
    });
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${await r.text()}`);
    const data = (await r.json()) as {
      content: Array<{ type: string; text?: string }>;
      usage: { input_tokens: number; output_tokens: number };
    };
    result = {
      text: data.content.map((c) => c.text ?? "").join(""),
      inputTokens: data.usage.input_tokens ?? 0,
      outputTokens: data.usage.output_tokens ?? 0,
      provider,
      model,
    };
  } else {
    const baseUrl = provider === "deepseek" ? "https://api.deepseek.com" : "https://api.openai.com";
    const apiKey = provider === "deepseek" ? env.DEEPSEEK_API_KEY : env.OPENAI_API_KEY;
    if (!apiKey) throw new Error(`${provider.toUpperCase()}_API_KEY not set`);

    const r = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
    });
    if (!r.ok) throw new Error(`${provider} ${r.status}: ${await r.text()}`);
    const data = (await r.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    result = {
      text: data.choices[0]?.message.content ?? "",
      inputTokens: data.usage.prompt_tokens ?? 0,
      outputTokens: data.usage.completion_tokens ?? 0,
      provider,
      model,
    };
  }

  if (opts.userId) {
    // Reconcile: refund the gap between reserved and actually used credits.
    const actual = tokensToCredits(result.inputTokens + result.outputTokens);
    if (reserved > actual) await refundCredits(opts.userId, reserved - actual);
    await recordUsage({
      userId: opts.userId,
      provider,
      kind: "chat",
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      metadata: { model },
    });
  }

  return result;
}
