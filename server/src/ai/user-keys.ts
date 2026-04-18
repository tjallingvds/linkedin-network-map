/**
 * Per-request user API keys (BYOK — bring your own key).
 *
 * The client stores keys in localStorage and sends them as `X-User-{Provider}-Key`
 * headers with every request. We never persist them server-side: they live only
 * in request memory.
 *
 * When a user provides their own key for a provider, we use it instead of the
 * workspace env var AND skip credit debiting — the user pays their provider
 * directly.
 */
import type { Request } from "express";

export interface UserKeys {
  openai?: string;
  anthropic?: string;
  deepseek?: string;
  tavily?: string;
  apollo?: string;
}

export function extractUserKeys(req: Request): UserKeys {
  const h = (name: string): string | undefined => {
    const raw = req.header(name);
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  return {
    openai: h("x-user-openai-key"),
    anthropic: h("x-user-anthropic-key"),
    deepseek: h("x-user-deepseek-key"),
    tavily: h("x-user-tavily-key"),
    apollo: h("x-user-apollo-key"),
  };
}
