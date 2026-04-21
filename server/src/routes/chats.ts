/**
 * Chats + messages + typed AI completion.
 *
 * The completion endpoint dispatches on `mode` (find | enrich | draft),
 * runs the matching handler (Tavily + AI), persists user + assistant
 * messages, and returns a typed CompletionResult shape the client renders.
 */
import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import type { AuthedRequest } from "../auth/session.js";
import { availableProviders } from "../ai/providers.js";
import type { AiProvider, CompletionResult, Prospect } from "@app/shared";
import { runFind } from "../ai/modes/find.js";
import { runNetwork } from "../ai/modes/network.js";
import { runEnrich } from "../ai/modes/enrich.js";
import { runDraft } from "../ai/modes/draft.js";
import { runFollowup } from "../ai/modes/followup.js";
import { runDiscoverMore } from "../ai/modes/discover-more.js";
import { extractUserKeys } from "../ai/user-keys.js";
import { aiJson } from "../ai/json.js";

const router = Router();

router.get("/", async (req: AuthedRequest, res) => {
  const rows = await db
    .selectFrom("chats")
    .selectAll()
    .where("user_id", "=", req.user!.id)
    .orderBy("updated_at", "desc")
    .limit(100)
    .execute();
  res.json({ chats: rows });
});

router.post("/", async (req: AuthedRequest, res) => {
  const body = z.object({ title: z.string().min(1).max(200).default("New chat") }).parse(req.body ?? {});
  const row = await db
    .insertInto("chats")
    .values({ user_id: req.user!.id, title: body.title })
    .returningAll()
    .executeTakeFirstOrThrow();
  res.status(201).json(row);
});

router.get("/:id/messages", async (req: AuthedRequest, res) => {
  const chat = await db
    .selectFrom("chats")
    .select("id")
    .where("id", "=", req.params.id)
    .where("user_id", "=", req.user!.id)
    .executeTakeFirst();
  if (!chat) return res.status(404).json({ error: "not_found" });

  const messages = await db
    .selectFrom("messages")
    .selectAll()
    .where("chat_id", "=", chat.id)
    .orderBy("created_at", "asc")
    .execute();
  res.json({ messages });
});

router.patch("/:id", async (req: AuthedRequest, res) => {
  const body = z.object({ title: z.string().min(1).max(200) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "invalid_body" });
  const row = await db
    .updateTable("chats")
    .set({ title: body.data.title, updated_at: new Date() as any })
    .where("id", "=", req.params.id)
    .where("user_id", "=", req.user!.id)
    .returningAll()
    .executeTakeFirst();
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json(row);
});

router.delete("/:id", async (req: AuthedRequest, res) => {
  const r = await db
    .deleteFrom("chats")
    .where("id", "=", req.params.id)
    .where("user_id", "=", req.user!.id)
    .executeTakeFirst();
  if (!r.numDeletedRows) return res.status(404).json({ error: "not_found" });
  res.status(204).end();
});

// ---- Typed completion ----
const completionSchema = z.object({
  content: z.string().min(1).max(20000),
  mode: z.enum(["find", "network", "enrich", "draft", "followup", "discover_more"]).default("find"),
  provider: z.enum(["openai", "anthropic", "deepseek"]).optional(),
  /** Selected prospects the user is drafting to (or the latest result set). */
  recipients: z.array(z.any()).optional(),
  /** Prior prospect list for followup / discover_more context. */
  previousProspects: z.array(z.any()).optional(),
  /** Original brief for discover_more re-runs. */
  previousBrief: z.string().max(2000).optional(),
});

router.post("/:id/completion", async (req: AuthedRequest, res) => {
  const parsed = completionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });

  const chat = await db
    .selectFrom("chats")
    .select(["id", "title"])
    .where("id", "=", req.params.id)
    .where("user_id", "=", req.user!.id)
    .executeTakeFirst();
  if (!chat) return res.status(404).json({ error: "not_found" });

  const userKeys = extractUserKeys(req);
  const provider: AiProvider =
    parsed.data.provider ?? availableProviders(userKeys)[0] ?? ("openai" as AiProvider);

  // Persist the user message so chat history is preserved.
  await db
    .insertInto("messages")
    .values({ chat_id: chat.id, role: "user", content: parsed.data.content })
    .execute();

  // Pull the full chat history (sans the user message we JUST wrote) so
  // the mode handlers can reason about prior context. "100" answering a
  // clarify question becomes "100" + "Find me 100 AI consultants …" —
  // the LLM stops asking clarifying questions it already got answers to.
  const history = await db
    .selectFrom("messages")
    .select(["role", "content", "result", "created_at"])
    .where("chat_id", "=", chat.id)
    .orderBy("created_at", "asc")
    .execute();
  const priorMessages = history
    .slice(0, -1) // drop the just-written user message; it's in `parsed.data.content`
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  // Pull every prospect name surfaced earlier in this chat so Find doesn't
  // re-surface them. The user saw "find people at X, Y, Z on the internet"
  // return names that had already appeared in a prior turn's Goldman Sachs
  // search — this is the fix.
  const alreadyShownNames: string[] = [];
  for (const m of history) {
    if (m.role !== "assistant") continue;
    const r = m.result as unknown;
    if (!r || typeof r !== "object") continue;
    const kind = (r as { kind?: string }).kind;
    if (kind !== "prospects") continue;
    const list = (r as { prospects?: Array<{ name?: string }> }).prospects ?? [];
    for (const p of list) {
      if (p && typeof p.name === "string" && p.name.trim()) {
        alreadyShownNames.push(p.name.trim());
      }
    }
  }
  // Dedupe — same person can appear in multiple assistant turns.
  const uniqAlreadyShown = Array.from(new Set(alreadyShownNames.map((n) => n.toLowerCase())))
    .map((lc) => alreadyShownNames.find((n) => n.toLowerCase() === lc)!)
    .filter(Boolean);

  // Decide NOW whether this turn should trigger AI title generation. We kick
  // it off BEFORE runFind so the 30-second Find pipeline doesn't starve the
  // title LLM call of API connection / rate limit budget — by the time runFind
  // is done, titlePromise has long since resolved.
  const userCountRow = await db
    .selectFrom("messages")
    .select(({ fn }) => [fn.count<number>("id").as("c")])
    .where("chat_id", "=", chat.id)
    .where("role", "=", "user")
    .executeTakeFirst();
  const userMsgCount = Number(userCountRow?.c ?? 0);
  // Always generate an AI title on the first user message. The client seeds
  // the chat row with a truncated copy of the user's text (so the sidebar
  // has *something* before the LLM returns) — if we also gated on
  // "title === New search", we'd never run the AI title pass for any chat
  // created normally via ensureChatId. Just trust userMsgCount.
  const shouldGenerateTitle = userMsgCount === 1;

  // Run title generation in parallel with the mode handler. Brief is
  // truncated to 400 chars so a 3KB multi-tier brief doesn't drown the
  // prompt in noise and cause Anthropic (no JSON mode) to truncate.
  const titlePromise: Promise<string | undefined> = shouldGenerateTitle
    ? (async () => {
        const briefForTitle = parsed.data.content.slice(0, 400);
        try {
          const t = await aiJson<{ title: string }>(
            provider,
            "You write a very short chat title (3-6 words, Title Case, no quotes, no trailing period). Focus on WHAT is being searched (role + company segment), not the count or adjectives.",
            `User's first message:\n${briefForTitle}\n\nReturn {"title": "<3-6 word title>"}. Examples: "Heads of Growth at Travel Aggregators", "CMOs in Healthcare Discovery", "AI Consultants for Banking".`,
            { maxTokens: 150, userId: req.user!.id, userKeys },
          );
          const candidate = t.title?.trim().replace(/^["']|["']$/g, "").slice(0, 80);
          if (candidate) {
            console.log(`[title] generated: "${candidate}"`);
            return candidate;
          }
          console.warn("[title] aiJson returned empty title");
          return undefined;
        } catch (err) {
          console.warn("[title] aiJson failed:", (err as Error).message);
          return undefined;
        }
      })()
    : Promise.resolve(undefined);

  // ── Keep-alive heartbeat ─────────────────────────────────────────────
  // Long-running Find / Enrich pipelines can run 30-120s. Railway's (and
  // most cloud proxies') HTTP layer kills the TCP connection if no bytes
  // flow on it for ~60s → user sees "Application failed to respond" and
  // we waste every Tavily credit already spent.
  //
  // Send response headers and a single whitespace byte every 10s while the
  // mode handler runs. JSON.parse ignores leading whitespace, so when we
  // finally write the real {result,provider,title} body, the client
  // parses it normally. No client change needed.
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx-style buffering if present
  res.flushHeaders?.();
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(" ");
  }, 10_000);

  let result: CompletionResult;
  try {
    const userId = req.user!.id;
    if (parsed.data.mode === "find") {
      result = await runFind(provider, parsed.data.content, userId, userKeys, priorMessages, uniqAlreadyShown);
    } else if (parsed.data.mode === "network") {
      result = await runNetwork(provider, parsed.data.content, userId, userKeys);
    } else if (parsed.data.mode === "enrich") {
      result = await runEnrich(provider, parsed.data.content, userId, userKeys);
    } else if (parsed.data.mode === "followup") {
      result = await runFollowup(
        provider,
        parsed.data.content,
        (parsed.data.previousProspects ?? []) as Prospect[],
        userId,
        userKeys,
      );
    } else if (parsed.data.mode === "discover_more") {
      const prev = (parsed.data.previousProspects ?? []) as Prospect[];
      const excludeNames = prev.map((p) => p.name).filter(Boolean);
      const brief = parsed.data.previousBrief?.trim() || parsed.data.content;
      result = await runDiscoverMore(provider, brief, excludeNames, userId, userKeys);
    } else {
      result = await runDraft(provider, parsed.data.content, (parsed.data.recipients ?? []) as Prospect[], userId, userKeys);
    }
  } catch (err) {
    clearInterval(heartbeat);
    writeErrorEnvelope(res, (err as Error).message);
    return;
  }
  clearInterval(heartbeat);

  // Everything past this point must also be wrapped so a DB / title failure
  // can't leave the client staring at a whitespace-only response body
  // (JSON.parse chokes with "Unexpected end of JSON input" when it does).
  try {
  // Persist both a human-readable timeline stub AND the full structured
  // result so prospect cards can be rebuilt on chat reload.
  const timelineText =
    result.kind === "text"
      ? result.content
      : result.kind === "prospects"
        ? `${result.summary} (${result.prospects.length} prospects)`
        : `Drafted ${result.drafts.length} outreach message${result.drafts.length === 1 ? "" : "s"}.`;

  await db
    .insertInto("messages")
    .values({
      chat_id: chat.id,
      role: "assistant",
      content: timelineText,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result: result as any,
    })
    .execute();

  // Resolve the AI title (kicked off BEFORE runFind so Find doesn't starve it).
  // The outer try/catch is defensive — titlePromise already catches its own
  // errors and resolves to undefined.
  let newTitle: string | undefined;
  if (shouldGenerateTitle) {
    let candidate: string | undefined;
    try {
      candidate = await titlePromise;
    } catch (err) {
      console.warn("[title] promise rejected:", (err as Error).message);
    }
    if (!candidate) {
      // Deliberate fallback: "Search: <first 60 chars>" so the sidebar row
      // is visibly DIFFERENT from the raw query. Users correctly called
      // out that a fallback identical to the query looks like the AI step
      // never ran.
      const firstLine = parsed.data.content.split(/\n/)[0]?.trim() ?? "";
      const truncated = firstLine.slice(0, 60).replace(/\s+\S*$/, "");
      candidate = truncated ? `Search: ${truncated}` : "Untitled search";
      console.warn(`[title] using fallback: "${candidate}"`);
    }
    newTitle = candidate;
    await db.updateTable("chats").set({ title: candidate }).where("id", "=", chat.id).execute();
  }

  await db.updateTable("chats").set({ updated_at: new Date() as any }).where("id", "=", chat.id).execute();

  // Headers + heartbeat whitespace already sent — use res.write/res.end,
  // NOT res.json (which calls setHeader again and errors). Client parses
  // leading whitespace fine; JSON.parse ignores it.
  if (!res.writableEnded) {
    res.write(JSON.stringify({ result, provider, title: newTitle }));
    res.end();
  }
  } catch (err) {
    console.error("[completion] post-mode failure:", (err as Error).message);
    writeErrorEnvelope(res, (err as Error).message);
  }
});

/** After we flushed headers (for the heartbeat), Express's default error
 *  handler can't send a 500 — it just closes the socket and the client
 *  sees a whitespace-only body. Write a JSON error envelope ourselves so
 *  response.json() succeeds with an {error, message} object. */
function writeErrorEnvelope(res: import("express").Response, message: string): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify({ error: "completion_failed", message });
  try {
    res.write(payload);
    res.end();
  } catch { /* socket already dead */ }
}

export default router;
