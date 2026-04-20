/**
 * Typed fetch wrapper. Same-origin in dev (via Vite proxy) so cookies flow
 * automatically; in production, VITE_API_URL points at the API origin.
 *
 * When VITE_MOCK_AUTH=1, many endpoints are intercepted by a localStorage-
 * backed mock (see lib/mockApi.ts) so the UI works without a running backend.
 * Real requests still go through for endpoints the mock doesn't handle.
 */
import { isMockApiEnabled, mockDispatch } from "./mockApi";
import { loadApiKeys } from "../components/SettingsDrawer";

const API_BASE = import.meta.env.VITE_API_URL || "";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** Build the per-request headers. Reads the user's API keys from localStorage
 *  and forwards them as X-User-{Provider}-Key — the server prefers these over
 *  its own env vars AND skips credit accounting when they're used. */
function buildHeaders(body?: unknown): HeadersInit {
  const h: Record<string, string> = {};
  if (body) h["Content-Type"] = "application/json";
  const keys = loadApiKeys();
  if (keys.openai) h["X-User-Openai-Key"] = keys.openai;
  if (keys.anthropic) h["X-User-Anthropic-Key"] = keys.anthropic;
  if (keys.deepseek) h["X-User-Deepseek-Key"] = keys.deepseek;
  if (keys.tavily) h["X-User-Tavily-Key"] = keys.tavily;
  if (keys.apollo) h["X-User-Apollo-Key"] = keys.apollo;
  return h;
}

/** Max wait before we give up on a request. Completions can legitimately
 *  take 60-90s (server heartbeat keeps the proxy happy) so the budget is
 *  long, but it's NOT infinite — a stuck proxy / crashed server should
 *  surface as "Load failed" rather than an eternal spinner. */
const DEFAULT_TIMEOUT_MS = 120_000;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (isMockApiEnabled()) {
    const mocked = await mockDispatch(method, path, body);
    if (mocked !== undefined) return mocked as T;
    // Fall through to real fetch for anything the mock doesn't handle.
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  let r: Response;
  try {
    r = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: "include",
      headers: buildHeaders(body),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    // AbortError from the timeout OR a genuine network failure. Surface
    // a uniform ApiError so the UI's catch handlers don't need to know
    // which one fired.
    if ((err as Error).name === "AbortError") {
      throw new ApiError(0, null, `Request timed out after ${DEFAULT_TIMEOUT_MS / 1000}s — the server may be restarting. Try again in a moment.`);
    }
    throw new ApiError(0, null, (err as Error).message || "Network error");
  }
  clearTimeout(timer);
  if (!r.ok) {
    let payload: unknown = null;
    try { payload = await r.json(); } catch { /* ignore */ }
    // Prefer the server's `message` (the human-readable reason) over `error`
    // (the machine code), so the UI surfaces things like "TAVILY_API_KEY not
    // set" instead of a generic "completion_failed".
    const pick = (k: string): string | null => {
      if (payload && typeof payload === "object" && k in payload) {
        const v = (payload as Record<string, unknown>)[k];
        return typeof v === "string" && v ? v : null;
      }
      return null;
    };
    const msg = pick("message") || pick("error") || r.statusText || `HTTP ${r.status}`;
    throw new ApiError(r.status, payload, msg);
  }
  if (r.status === 204) return undefined as T;
  return (await r.json()) as T;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, body?: unknown) => request<T>("POST", p, body),
  patch: <T>(p: string, body?: unknown) => request<T>("PATCH", p, body),
  del: <T>(p: string) => request<T>("DELETE", p),
};
