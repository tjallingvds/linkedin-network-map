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

  let result: CompletionResult;
  try {
    const userId = req.user!.id;
    if (parsed.data.mode === "find") {
      result = await runFind(provider, parsed.data.content, userId, userKeys);
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
    return res.status(500).json({
      error: "completion_failed",
      message: (err as Error).message,
    });
  }

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

  // If this is the very first user message in the chat, have the LLM
  // synthesize a short title so the sidebar doesn't just say "New search".
  // Cap at one title generation per chat.
  let newTitle: string | undefined;
  try {
    const userCountRow = await db
      .selectFrom("messages")
      .select(({ fn }) => [fn.count<number>("id").as("c")])
      .where("chat_id", "=", chat.id)
      .where("role", "=", "user")
      .executeTakeFirst();
    const userMsgCount = Number(userCountRow?.c ?? 0);
    if (userMsgCount === 1 && (chat.title === "New search" || !chat.title.trim())) {
      const t = await aiJson<{ title: string }>(
        provider,
        "You write a very short chat title (3-6 words, Title Case, no quotes, no trailing period).",
        `Brief:\n${parsed.data.content}\n\nReturn {"title": "<3-6 word title>"}.`,
        { maxTokens: 60, userId: req.user!.id, userKeys },
      );
      const candidate = t.title?.trim().replace(/^["']|["']$/g, "").slice(0, 80);
      if (candidate) {
        newTitle = candidate;
        await db.updateTable("chats").set({ title: candidate }).where("id", "=", chat.id).execute();
      }
    }
  } catch { /* title generation is best-effort */ }

  await db.updateTable("chats").set({ updated_at: new Date() as any }).where("id", "=", chat.id).execute();

  res.json({ result, provider, title: newTitle });
});

export default router;
