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

import type { UserKeys } from "./user-keys.js";

export function hasKey(provider: AiProvider, userKeys?: UserKeys): boolean {
  switch (provider) {
    case "openai":
      return !!(userKeys?.openai ?? env.OPENAI_API_KEY);
    case "anthropic":
      return !!(userKeys?.anthropic ?? env.ANTHROPIC_API_KEY);
    case "deepseek":
      return !!(userKeys?.deepseek ?? env.DEEPSEEK_API_KEY);
  }
}

export function availableProviders(userKeys?: UserKeys): AiProvider[] {
  return (["openai", "anthropic", "deepseek"] as AiProvider[]).filter((p) => hasKey(p, userKeys));
}

function providerKey(provider: AiProvider, userKeys?: UserKeys): { key: string | undefined; byok: boolean } {
  const user =
    provider === "openai" ? userKeys?.openai :
    provider === "anthropic" ? userKeys?.anthropic :
    userKeys?.deepseek;
  if (user) return { key: user, byok: true };
  const fallback =
    provider === "openai" ? env.OPENAI_API_KEY :
    provider === "anthropic" ? env.ANTHROPIC_API_KEY :
    env.DEEPSEEK_API_KEY;
  return { key: fallback, byok: false };
}

export async function aiChat(
  provider: AiProvider,
  messages: AiMessage[],
  opts: { maxTokens?: number; temperature?: number; userId?: string; userKeys?: UserKeys } = {},
): Promise<AiCallResult> {
  const maxTokens = opts.maxTokens ?? 2048;
  const temperature = opts.temperature ?? 0.2;
  const model = MODELS[provider];
  const { key: apiKey, byok } = providerKey(provider, opts.userKeys);
  // BYOK: skip credit accounting — the user pays their provider directly.
  const chargeUserId = byok ? undefined : opts.userId;

  // Reserve a conservative upper bound: prompt length + max output tokens.
  const estInput = Math.ceil(messages.reduce((a, m) => a + m.content.length, 0) / 4);
  const reserved = tokensToCredits(estInput + maxTokens);
  if (chargeUserId) await reserveCredits(chargeUserId, reserved);

  let result: AiCallResult;

  if (provider === "anthropic") {
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const convo = messages.filter((m) => m.role !== "system");

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
    if (!apiKey) throw new Error(`${provider.toUpperCase()}_API_KEY not set`);
    const baseUrl = provider === "deepseek" ? "https://api.deepseek.com" : "https://api.openai.com";

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

  if (chargeUserId) {
    const actual = tokensToCredits(result.inputTokens + result.outputTokens);
    if (reserved > actual) await refundCredits(chargeUserId, reserved - actual);
    await recordUsage({
      userId: chargeUserId,
      provider,
      kind: "chat",
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      metadata: { model },
    });
  }

  return result;
}
