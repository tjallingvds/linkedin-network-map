/**
 * Typed fetch wrapper. Same-origin in dev (via Vite proxy) so cookies flow
 * automatically; in production, VITE_API_URL points at the API origin.
 *
 * When VITE_MOCK_AUTH=1, many endpoints are intercepted by a localStorage-
 * backed mock (see lib/mockApi.ts) so the UI works without a running backend.
 * Real requests still go through for endpoints the mock doesn't handle.
 */
import { isMockApiEnabled, mockDispatch } from "./mockApi";

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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (isMockApiEnabled()) {
    const mocked = await mockDispatch(method, path, body);
    if (mocked !== undefined) return mocked as T;
    // Fall through to real fetch for anything the mock doesn't handle.
  }

  const r = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
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
