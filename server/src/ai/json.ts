/**
 * JSON-mode helper for all three providers. Every call records usage if a
 * userId is supplied.
 */
import { env } from "../env.js";
import type { AiProvider } from "@app/shared";
import { recordUsage } from "../usage/tracker.js";
import type { UserKeys } from "./user-keys.js";

// JSON-mode pins deepseek-chat, NOT the flash tier: deepseek-v4-flash
// intermittently ignores response_format:json_object and echoes prose, which
// breaks structured parsing. Flash is used only for free-text (see
// providers.ts / aiChat). The retry below is a safety net, not a license to
// run a JSON-unreliable model here.
const MODELS: Record<AiProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-6",
  deepseek: "deepseek-chat",
};

/** Thrown when an LLM provider rejects the call because the account is out
 *  of credits / over the rate or spending limit. */
export class LlmQuotaError extends Error {
  readonly kind = "llm_quota" as const;
  readonly provider: AiProvider;
  readonly byok: boolean;
  constructor(provider: AiProvider, message: string, byok: boolean) {
    super(message);
    this.name = "LlmQuotaError";
    this.provider = provider;
    this.byok = byok;
  }
}

/** Thrown when an LLM provider rejects the API key as invalid / revoked. */
export class LlmAuthError extends Error {
  readonly kind = "llm_auth" as const;
  readonly provider: AiProvider;
  readonly byok: boolean;
  constructor(provider: AiProvider, message: string, byok: boolean) {
    super(message);
    this.name = "LlmAuthError";
    this.provider = provider;
    this.byok = byok;
  }
}

export function isLlmQuotaError(e: unknown): e is LlmQuotaError {
  return e instanceof LlmQuotaError;
}
export function isLlmAuthError(e: unknown): e is LlmAuthError {
  return e instanceof LlmAuthError;
}

/** Map a provider HTTP failure into a typed quota/auth error when the body
 *  shows the canonical patterns. Falls back to a generic Error otherwise. */
function classifyProviderError(
  provider: AiProvider,
  status: number,
  body: string,
  byok: boolean,
): Error {
  const lower = body.toLowerCase();
  const isQuota =
    status === 402 ||
    status === 429 ||
    lower.includes("insufficient_quota") ||
    lower.includes("you exceeded your current quota") ||
    lower.includes("rate_limit") ||
    lower.includes("rate limit") ||
    lower.includes("billing") ||
    lower.includes("credit balance is too low") ||
    lower.includes("monthly limit") ||
    lower.includes("quota exceeded");
  const isAuth =
    status === 401 ||
    status === 403 ||
    lower.includes("invalid_api_key") ||
    lower.includes("invalid api key") ||
    lower.includes("incorrect api key") ||
    lower.includes("authentication");
  if (isQuota) return new LlmQuotaError(provider, `${provider} quota exhausted (HTTP ${status}): ${body.slice(0, 200)}`, byok);
  if (isAuth) return new LlmAuthError(provider, `${provider} auth failed (HTTP ${status}): ${body.slice(0, 200)}`, byok);
  return new Error(`${provider} ${status}: ${body}`);
}

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

  let inputTokens = 0;
  let outputTokens = 0;

  // Hard timeout on the upstream LLM call. Without this, a hung provider
  // (rare but happens) leaves the fetch pending forever while the chat
  // route's heartbeat keeps the TCP socket alive — eventually the cloud
  // proxy kills the whole server process at its request cap and the user
  // sees "Failed to fetch" with no useful logs.
  const callWithTimeout = async (url: string, init: RequestInit, ms = 60_000): Promise<Response> => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`${provider} timed out after ${ms / 1000}s`);
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  };

  // One request → raw text. `reinforce` strengthens the JSON instruction on a
  // retry after the first reply came back as prose (some models — notably
  // deepseek's flash tier — intermittently ignore response_format and echo
  // the prompt or emit a sentence instead of an object). Usage from BOTH
  // attempts is recorded so the cost of a retry is never hidden.
  const requestRaw = async (reinforce: boolean): Promise<string> => {
    const jsonNudge = reinforce
      ? "\n\nCRITICAL: Your previous reply was NOT valid JSON. Respond with ONLY a single JSON object — no prose, no explanation, no markdown fences, no leading or trailing text."
      : "";
    if (provider === "anthropic") {
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
      const r = await callWithTimeout("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: `${systemPrompt}\n\nReturn valid JSON only. No prose, no markdown fences.${jsonNudge}`,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });
      if (!r.ok) throw classifyProviderError("anthropic", r.status, await r.text(), byok);
      const data = (await r.json()) as {
        content: Array<{ type: string; text?: string }>;
        usage: { input_tokens: number; output_tokens: number };
      };
      inputTokens += data.usage.input_tokens ?? 0;
      outputTokens += data.usage.output_tokens ?? 0;
      return data.content.map((c) => c.text ?? "").join("").trim();
    }
    if (!apiKey) throw new Error(`${provider.toUpperCase()}_API_KEY not set`);
    const baseUrl = provider === "deepseek" ? "https://api.deepseek.com" : "https://api.openai.com";
    const r = await callWithTimeout(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `${systemPrompt}\nReturn a JSON object.${jsonNudge}` },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!r.ok) throw classifyProviderError(provider, r.status, await r.text(), byok);
    const data = (await r.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    inputTokens += data.usage.prompt_tokens ?? 0;
    outputTokens += data.usage.completion_tokens ?? 0;
    return data.choices[0]?.message.content ?? "";
  };

  const record = async () => {
    if (opts.userId) {
      await recordUsage({
        userId: opts.userId, provider, kind: "json",
        inputTokens, outputTokens, metadata: { model, byok },
      });
    }
  };

  // First attempt; on a parse failure (non-JSON / prose echo) retry ONCE with
  // a reinforced instruction before giving up. Recovers the common flash-tier
  // failure where the model returns a sentence instead of an object.
  let raw = await requestRaw(false);
  try {
    const parsed = parseJson<T>(raw);
    await record();
    return parsed;
  } catch {
    raw = await requestRaw(true);
    await record();
    return parseJson<T>(raw);
  }
}

function parseJson<T>(raw: string): T {
  const cleaned = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const m = cleaned.match(/[[{][\s\S]*[\]}]/);
    if (m) {
      try { return JSON.parse(m[0]) as T; } catch { /* fall through to recovery */ }
    }
    // Recovery for truncated output: when the model hits maxTokens mid-string,
    // we get something like '{"answer":"...long text', missing closing punctuation.
    // Walk the prefix forward, terminate the open string at the last whole word,
    // then append the missing closing brackets/braces in the right order.
    const recovered = recoverTruncatedJson(cleaned);
    if (recovered != null) {
      try { return JSON.parse(recovered) as T; } catch { /* couldn't salvage */ }
    }
    throw new Error(`AI returned non-JSON: ${cleaned.slice(0, 200)}`);
  }
}

/** Best-effort recovery of a JSON value that was cut off mid-output.
 *  Tracks the brace/bracket stack and the open-string state, then closes
 *  whatever was left dangling. Returns null if the input doesn't look like
 *  JSON at all. */
function recoverTruncatedJson(s: string): string | null {
  // Find the start of the JSON value.
  const start = s.search(/[[{]/);
  if (start === -1) return null;
  let i = start;
  const stack: string[] = []; // entries are "}" or "]"
  let inString = false;
  let escape = false;
  for (; i < s.length; i++) {
    const c = s[i]!;
    if (inString) {
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === '"') { inString = false; continue; }
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") stack.pop();
  }
  let trimmed = s.slice(start);
  if (inString) {
    // Close the dangling string. Trim any trailing backslash that would
    // otherwise escape the closing quote we're about to add.
    if (trimmed.endsWith("\\")) trimmed = trimmed.slice(0, -1);
    trimmed += '"';
  }
  // A trailing comma (e.g. inside an array we never finished) is not legal —
  // strip it before closing the structure.
  trimmed = trimmed.replace(/,\s*$/, "");
  // Append closers in reverse stack order.
  while (stack.length) trimmed += stack.pop();
  return trimmed;
}
