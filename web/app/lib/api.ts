/** Typed fetch against the existing CRM API. Same-origin via the rewrite in
 *  next.config.ts, so the session cookie flows automatically. */
import type { CrmBoard, CrmContact } from "./types";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`${r.status} ${path}: ${body.slice(0, 200)}`);
  }
  return r.status === 204 ? (undefined as T) : ((await r.json()) as T);
}

export const api = {
  boards: () => req<{ boards: CrmBoard[] }>("/api/crm/boards"),
  contacts: (boardId: string) =>
    req<{ contacts: CrmContact[] }>(`/api/crm/boards/${boardId}/contacts`),
  patchContact: (id: string, patch: Partial<CrmContact>) =>
    req<CrmContact>(`/api/crm/contacts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  session: () => req<{ user?: { name?: string; email?: string } }>("/api/auth/session"),
};
