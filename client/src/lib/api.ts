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
  setKeyHeader(h, "X-User-Openai-Key",    keys.openai,    "OpenAI");
  setKeyHeader(h, "X-User-Anthropic-Key", keys.anthropic, "Anthropic");
  setKeyHeader(h, "X-User-Deepseek-Key",  keys.deepseek,  "DeepSeek");
  setKeyHeader(h, "X-User-Tavily-Key",    keys.tavily,    "Tavily");
  setKeyHeader(h, "X-User-Apollo-Key",    keys.apollo,    "Apollo");
  return h;
}

/** Sanitize a localStorage-stored API key into something the browser will
 *  accept as an HTTP header value (Latin-1 / RFC 7230 token-ish).
 *
 *  Past failure mode: a key pasted from a source with smart quotes, em-dashes,
 *  or non-breaking spaces ends up containing a code point > 0xFF. fetch()
 *  then refuses the entire request with "Failed to read the 'headers'
 *  property from 'RequestInit': String contains non ISO-8859-1 code point",
 *  blocking ALL API calls — not just the one that needed that key.
 *
 *  Strategy: trim surrounding whitespace + zero-width junk, then verify
 *  the value is plain ASCII visible chars. If not, omit the header (server
 *  falls back to its env key) and warn so the user knows which one to fix
 *  in Settings. */
function setKeyHeader(
  h: Record<string, string>,
  name: string,
  value: string | undefined,
  label: string,
): void {
  if (!value) return;
  // Strip BOM, zero-width spaces/joiners, NBSP, and surrounding whitespace.
  const cleaned = value
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "")
    .trim();
  if (!cleaned) return;
  // RFC 7230: header field values are visible ASCII (0x20-0x7E). Anything
  // outside that — smart quotes, em-dashes, accented chars, control chars —
  // either trips the browser (>0xFF) or the server's parser (<0x20).
  if (!/^[\x20-\x7E]+$/.test(cleaned)) {
    console.warn(
      `[api] ${label} API key contains non-ASCII characters and was dropped from this request. ` +
      `Re-paste it in Settings → API keys (smart quotes / em-dashes / non-breaking spaces from a copy-paste are the usual culprit).`,
    );
    return;
  }
  h[name] = cleaned;
}

/** Max wait before we give up on a request. Completions can legitimately
 *  take 60-90s (server heartbeat keeps the proxy happy) so the budget is
 *  long, but it's NOT infinite — a stuck proxy / crashed server should
 *  surface as "Load failed" rather than an eternal spinner. */
const DEFAULT_TIMEOUT_MS = 120_000;

async function request<T>(method: string, path: string, body?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
  if (isMockApiEnabled()) {
    const mocked = await mockDispatch(method, path, body);
    if (mocked !== undefined) return mocked as T;
    // Fall through to real fetch for anything the mock doesn't handle.
  }

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
      throw new ApiError(0, null, `Request timed out after ${timeoutMs / 1000}s — the server may be restarting. Try again in a moment.`);
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

  // Read as text first so we can recover from a whitespace-only / empty body.
  // The chat-completion route flushes 200 OK + Content-Type early and writes
  // heartbeat whitespace while Find runs. If the cloud proxy kills the socket
  // (Railway/Render cap requests at ~120-300s), the server is restarted, or
  // the handler crashes between heartbeats, the client receives some
  // whitespace and no JSON. r.json() then throws "Unexpected end of JSON
  // input" raw to the caller — useless to the user. Detect that case and
  // surface a real "the server cut us off" message instead.
  const rawBody = await r.text();
  const trimmed = rawBody.trim();
  if (!trimmed) {
    throw new ApiError(
      r.status,
      null,
      "The server stopped responding mid-request. This usually means the request hit a hosting-platform timeout cap (long Find runs over many firms can do this) or the server restarted. Try again — narrowing the brief (fewer firms or fewer titles per query) often helps.",
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    // Body is non-empty but not valid JSON — usually a partial heartbeat-then-
    // truncation, or an HTML error page from the cloud proxy itself. Show a
    // snippet so the user / logs have something to debug from.
    throw new ApiError(
      r.status,
      null,
      `The server returned a malformed response. Try again. (First 120 chars: ${trimmed.slice(0, 120).replace(/\s+/g, " ")})`,
    );
  }

  // Post-flush error envelope: the chat-completion route flushes 200 OK +
  // Content-Type early so proxies don't kill long Find runs. If the handler
  // then throws, writeErrorEnvelope writes {"error":..,"message":..} on the
  // already-200 response. Without this guard the body parses as "success",
  // callers do `resp.result.kind` and the page crashes with
  // "Cannot read properties of undefined (reading 'kind')".
  if (
    data && typeof data === "object" &&
    "error" in data && typeof (data as Record<string, unknown>).error === "string" &&
    !("result" in data)
  ) {
    const obj = data as Record<string, unknown>;
    const msg = typeof obj.message === "string" && obj.message
      ? obj.message
      : typeof obj.error === "string" ? obj.error
      : "Request failed";
    throw new ApiError(r.status, data, msg);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string, opts?: { timeoutMs?: number }) => request<T>("GET", p, undefined, opts),
  post: <T>(p: string, body?: unknown, opts?: { timeoutMs?: number }) => request<T>("POST", p, body, opts),
  patch: <T>(p: string, body?: unknown) => request<T>("PATCH", p, body),
  del: <T>(p: string) => request<T>("DELETE", p),
};
