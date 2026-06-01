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
import { aiJson, isLlmQuotaError, isLlmAuthError } from "../ai/json.js";
import { isTavilyQuotaError, isTavilyAuthError, isTavilyKeyMissingError, isWebSearchFailedError } from "../ai/tavily.js";

const router = Router();

/** A message row as loaded for branch walking. */
type BranchRow = { id: string; parent_id: string | null; role: string; content: string; result: unknown };

/** Walk up the chat tree from `startId` to the root via parent_id and return
 *  the chain in root→start order. Used to scope a turn's context (prior
 *  messages + already-shown names) to the ACTIVE branch, so messages on
 *  abandoned sibling branches don't leak into the prompt or the dedup set.
 *  Returns [] when startId is null (a fresh branch root has no prior context).
 *  A `seen` guard makes a malformed cycle terminate instead of hang. */
function branchUpTo(all: BranchRow[], startId: string | null): BranchRow[] {
  if (!startId) return [];
  const byId = new Map(all.map((r) => [r.id, r]));
  const chain: BranchRow[] = [];
  const seen = new Set<string>();
  let cur = byId.get(startId) ?? null;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parent_id ? byId.get(cur.parent_id) ?? null : null;
  }
  return chain.reverse();
}

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
    .select(["id", "parent_id", "role", "content", "result", "created_at"])
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
  /** Original brief for discover_more re-runs. Matches the `content` cap —
   *  the brief IS user-authored content, so capping it lower than `content`
   *  caused legitimate long briefs (≥2000 chars) to 400 with invalid_body
   *  the moment the user hit "Discover more" or sent a refinement. */
  previousBrief: z.string().max(20000).optional(),
  /** Branch point for the new user message. The new message attaches under
   *  this parent — pass the active leaf's id for a normal follow-up, or an
   *  edited message's OWN parent to fork a sibling branch. Null/omitted =
   *  branch root (first message in a fresh thread). */
  parentId: z.string().uuid().nullable().optional(),
  /** Retry: regenerate the assistant answer for this existing user message
   *  as a sibling, WITHOUT inserting a new user message. Mutually exclusive
   *  with a normal turn — when set, `content` should echo that user
   *  message's text so the mode handler re-runs the same request. */
  regenerateAssistantForUserId: z.string().uuid().optional(),
  /** Per-search archetype-gate breadth. "broad" (default) accepts adjacent
   *  senior roles in the same function family; "strict" matches only the
   *  exact archetypes named in the brief. */
  matchBreadth: z.enum(["strict", "broad"]).optional(),
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

  // Load the whole chat tree once (before inserting this turn's user
  // message) so we can scope context to the active branch via parent_id.
  const allMessages = await db
    .selectFrom("messages")
    .select(["id", "parent_id", "role", "content", "result"])
    .where("chat_id", "=", chat.id)
    .orderBy("created_at", "asc")
    .execute();

  // Resolve this turn into a tree position.
  //   - Retry: regenerate the answer for an existing user message as a
  //     sibling assistant — DON'T insert a new user message. Context is the
  //     branch up to (and including) that user message's parent.
  //   - Normal / edit: insert a new user message under `parentId` (the active
  //     leaf for a follow-up, or an edited message's own parent to fork).
  const isRetry = !!parsed.data.regenerateAssistantForUserId;
  let currentUserMessageId: string;
  let createdUserMessage = false;
  let anchorParentId: string | null; // parent of the current user message — the prior-context branch tip

  if (isRetry) {
    const target = allMessages.find(
      (m) => m.id === parsed.data.regenerateAssistantForUserId && m.role === "user",
    );
    if (!target) return res.status(400).json({ error: "invalid_retry_target" });
    currentUserMessageId = target.id;
    anchorParentId = target.parent_id;
  } else {
    const parentId = parsed.data.parentId ?? null;
    const inserted = await db
      .insertInto("messages")
      .values({ chat_id: chat.id, role: "user", content: parsed.data.content, parent_id: parentId })
      .returning("id")
      .executeTakeFirstOrThrow();
    currentUserMessageId = inserted.id;
    createdUserMessage = true;
    anchorParentId = parentId;
  }

  // Prior context = the active branch ABOVE the current user message. Using
  // the tree (not created_at) keeps abandoned sibling branches out of the
  // prompt and the dedup set. "100" answering a clarify question still lands
  // right after "Find me 100 AI consultants …" on the same branch.
  const branch = branchUpTo(allMessages, anchorParentId);
  const priorMessages = branch.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  // Pull every prospect name surfaced earlier ON THIS BRANCH so Find doesn't
  // re-surface them — scoped to the branch so a discarded edit's results
  // don't suppress people on the branch the user actually kept.
  const alreadyShownNames: string[] = [];
  for (const m of branch) {
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
  // Also pull names from the user's CRM so Find doesn't recommend people
  // they've already added to a board. Scoped to boards the user owns OR is
  // a member of — if a collaborator added someone to a shared pipeline,
  // surfacing them again would waste an outreach slot.
  try {
    const myBoards = await db
      .selectFrom("crm_boards")
      .select("id")
      .where("user_id", "=", req.user!.id)
      .execute();
    const memberBoards = await db
      .selectFrom("crm_board_members")
      .select("board_id")
      .where("user_id", "=", req.user!.id)
      .execute();
    const boardIds = [...new Set([...myBoards.map((b) => b.id), ...memberBoards.map((m) => m.board_id)])];
    if (boardIds.length > 0) {
      const crmRows = await db
        .selectFrom("crm_contacts")
        .select(["name"])
        .where("board_id", "in", boardIds)
        .execute();
      for (const row of crmRows) {
        if (row.name && row.name.trim()) alreadyShownNames.push(row.name.trim());
      }
    }
  } catch (err) {
    // Non-fatal — if the CRM lookup fails we still run Find, just without
    // the CRM-aware exclusion layer.
    console.warn("[chats] crm exclusion lookup failed:", (err as Error).message);
  }

  // Dedupe — same person can appear in multiple assistant turns or on
  // multiple boards.
  const uniqAlreadyShown = Array.from(new Set(alreadyShownNames.map((n) => n.toLowerCase())))
    .map((lc) => alreadyShownNames.find((n) => n.toLowerCase() === lc)!)
    .filter(Boolean);

  // Decide NOW whether this turn should trigger AI title generation. We kick
  // it off BEFORE runFind so the 30-second Find pipeline doesn't starve the
  // title LLM call of API connection / rate limit budget — by the time runFind
  // is done, titlePromise has long since resolved.
  //
  // Title only on the genuinely-first user message: we created a NEW user
  // message AND there were zero user messages before this turn. Editing a
  // first message (a sibling) or retrying an answer must NOT regenerate the
  // title. `allMessages` was loaded before the insert, so it reflects the
  // pre-turn state.
  const priorUserMsgCount = allMessages.filter((m) => m.role === "user").length;
  const shouldGenerateTitle = createdUserMessage && priorUserMsgCount === 0;

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
            `User's first message:\n${briefForTitle}\n\nReturn {"title": "<3-6 word title>"} — Title Case, no quotes, no trailing period. Format the title as "<Role> <preposition> <Segment-or-Company>" using the brief's OWN vocabulary. Do NOT invent industries, role categories, or company names that don't appear in the brief.`,
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

  const matchBreadth = parsed.data.matchBreadth ?? "broad";
  let result: CompletionResult;
  try {
    const userId = req.user!.id;
    if (parsed.data.mode === "find") {
      result = await runFind(provider, parsed.data.content, userId, userKeys, priorMessages, uniqAlreadyShown, matchBreadth);
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
      // Merge the previous-prospects exclusion with the CRM-backed
      // exclusion so "find more" doesn't re-recommend people already on
      // one of the user's boards. uniqAlreadyShown already includes both
      // chat-history names and CRM names.
      const excludeNames = Array.from(new Set([
        ...prev.map((p) => p.name).filter(Boolean),
        ...uniqAlreadyShown,
      ]));
      const brief = parsed.data.previousBrief?.trim() || parsed.data.content;
      result = await runDiscoverMore(provider, brief, excludeNames, userId, userKeys, matchBreadth);
    } else {
      result = await runDraft(provider, parsed.data.content, (parsed.data.recipients ?? []) as Prospect[], userId, userKeys);
    }
  } catch (err) {
    clearInterval(heartbeat);
    // Typed quota/auth errors get rendered as a normal "text" CompletionResult
    // so the chat shows a clean, actionable card — not a generic
    // "completion_failed" envelope. Without this, a Tavily 432 looked
    // identical to "no results found" and the user couldn't tell their
    // credit was the actual blocker.
    const friendly = renderUpstreamError(err);
    if (friendly) {
      const result: CompletionResult = { kind: "text", content: friendly };
      // Persist the friendly text as the assistant message (under the current
      // user message) so the chat history + tree reflect what the user saw.
      const errAssistant = await db.insertInto("messages").values({
        chat_id: chat.id, role: "assistant", content: friendly,
        result: result as unknown as object, parent_id: currentUserMessageId,
      }).returning("id").executeTakeFirst().catch(() => undefined);
      if (!res.writableEnded) {
        res.write(JSON.stringify({
          result, provider,
          userMessageId: createdUserMessage ? currentUserMessageId : undefined,
          assistantMessageId: errAssistant?.id,
        }));
        res.end();
      }
      return;
    }
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

  const assistantRow = await db
    .insertInto("messages")
    .values({
      chat_id: chat.id,
      role: "assistant",
      content: timelineText,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result: result as any,
      parent_id: currentUserMessageId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

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
  //
  // Return the new message ids so the client can graft this turn into its
  // message tree and point the active branch at it — no full refetch needed.
  if (!res.writableEnded) {
    res.write(JSON.stringify({
      result, provider, title: newTitle,
      userMessageId: createdUserMessage ? currentUserMessageId : undefined,
      assistantMessageId: assistantRow.id,
    }));
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
/** Turn a typed upstream error into a chat-ready message. Returns null when
 *  the error is something else (caller falls back to writeErrorEnvelope).
 *
 *  Format is plain HTML with a leading sentinel (<div class="upstream-error
 *  upstream-error-{quota|auth}-{provider}">…). The DiscoverPage renderer
 *  already supports HTML in text results, so the error renders as a styled
 *  card instead of raw text. */
function renderUpstreamError(err: unknown): string | null {
  if (isTavilyQuotaError(err)) {
    return wrapErrCard(
      "tavily-quota",
      "Tavily web-search credit limit reached",
      err.byok
        ? "Your personal Tavily key has run out of monthly credits. Top it up at <a href=\"https://app.tavily.com/\" target=\"_blank\" rel=\"noreferrer\">tavily.com</a>, then re-run."
        : "The shared Tavily quota for this workspace is exhausted. Add your own Tavily key in <strong>Settings → API keys</strong> to keep searching — you'll only spend your own credits.",
    );
  }
  if (isTavilyAuthError(err)) {
    return wrapErrCard(
      "tavily-auth",
      "Tavily rejected the API key",
      err.byok
        ? "Your Tavily key was rejected as invalid. Re-paste it in <strong>Settings → API keys</strong> — make sure there are no stray spaces or smart quotes."
        : "The server's Tavily key is invalid or revoked. Add your own Tavily key in <strong>Settings → API keys</strong> as a workaround, then ping the team to fix the shared one.",
    );
  }
  if (isTavilyKeyMissingError(err)) {
    return wrapErrCard(
      "tavily-missing",
      "No web-search key configured",
      "Web search runs on <strong>Tavily</strong>, which is separate from your LLM (DeepSeek) key — topping up DeepSeek won't enable search. Add a Tavily key in <strong>Settings → API keys</strong> (get one free at <a href=\"https://app.tavily.com/\" target=\"_blank\" rel=\"noreferrer\">tavily.com</a>), then re-run.",
    );
  }
  if (isWebSearchFailedError(err)) {
    return wrapErrCard(
      "web-search-failed",
      "Web search failed",
      "Every search query errored out before returning results — this is a transient web-search failure, <strong>not</strong> an empty result set, so the firms/titles in your brief are fine. Wait a moment and re-run; if it keeps happening, check the server logs.",
    );
  }
  if (isLlmQuotaError(err)) {
    const provider = prettyProvider(err.provider);
    return wrapErrCard(
      `llm-quota-${err.provider}`,
      `${provider} credit/quota limit reached`,
      err.byok
        ? `Your personal ${provider} key has hit its quota or rate limit. Top up your account, then re-run.`
        : `The shared ${provider} quota is exhausted. Add your own ${provider} key in <strong>Settings → API keys</strong> to keep working.`,
    );
  }
  if (isLlmAuthError(err)) {
    const provider = prettyProvider(err.provider);
    return wrapErrCard(
      `llm-auth-${err.provider}`,
      `${provider} rejected the API key`,
      err.byok
        ? `Your ${provider} key was rejected. Re-paste it in <strong>Settings → API keys</strong>.`
        : `The shared ${provider} key is invalid. Add your own in <strong>Settings → API keys</strong> to keep working.`,
    );
  }
  return null;
}

function prettyProvider(p: AiProvider): string {
  return p === "openai" ? "OpenAI" : p === "anthropic" ? "Anthropic" : "DeepSeek";
}

function wrapErrCard(slug: string, title: string, body: string): string {
  return `<div class="upstream-error upstream-error-${slug}"><p><strong>${title}</strong></p><p>${body}</p></div>`;
}

function writeErrorEnvelope(res: import("express").Response, message: string): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify({ error: "completion_failed", message });
  try {
    res.write(payload);
    res.end();
  } catch { /* socket already dead */ }
}

export default router;
