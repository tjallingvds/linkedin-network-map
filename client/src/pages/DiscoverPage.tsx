/**
 * Discover — primary Observable Intuition workspace. The composer is search-only;
 * enrichment lives in the CRM (per-board "Enrich with Apollo" button).
 * Outreach drafts are triggered from the selection bar.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Company, CompletionResult, CrmBoard, OutreachDraft, Prospect } from "@app/shared";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";
import { useModal } from "../components/Modal";
import { Sidebar } from "../components/Sidebar";
import { useUsage } from "../lib/useUsage";
import { ProspectGrid } from "../components/ProspectCard";
import { CompanyGrid } from "../components/CompanyCard";
import { DetailDrawer } from "../components/DetailDrawer";
import { OutreachDrawer } from "../components/OutreachDrawer";
import { CRMView } from "../components/CRMView";
import { SettingsDrawer } from "../components/SettingsDrawer";
import { ConnectionsImportModal } from "../components/ConnectionsImportModal";
import {
  IconSearch, IconSparkle, IconArrowUp,
  IconCheck, IconSave, IconDownload, IconSheet, IconSend, IconUsers,
  IconCopy, IconEdit, IconRetry, IconChevL, IconChevR,
} from "../design/icons";

type ThreadEntry =
  | { role: "user"; text: string }
  | { role: "ai"; thinking: true; steps: string[] }
  | { role: "ai"; summary: string; prospects: Prospect[] }
  | { role: "ai"; summary: string; companies: Company[] }
  | { role: "ai"; text: string; isError?: boolean; keyMissing?: KeyErrorHint };

type KeyErrorHint = { providers: string[] };
interface ChatListItem { id: string; title: string; updated_at: string; }

// ── Chat message tree ──────────────────────────────────────────────────────
// The chat is a tree (server `messages.parent_id`), not a flat list. Editing a
// message forks a sibling branch; retrying an answer adds a sibling assistant;
// the visible conversation is the active root→leaf path. A node carries the
// already-rendered shape so the render memo stays a pure projection.
type ChatNode = {
  id: string;
  parentId: string | null;
  order: number; // monotonic; newest sibling is the default-active one
  role: "user" | "ai";
  text?: string;
  summary?: string;
  prospects?: Prospect[];
  companies?: Company[];
  isError?: boolean;
  keyMissing?: KeyErrorHint;
};

// Branch metadata attached to a rendered entry so the row can show a version
// switcher + edit/copy/retry actions. Absent on the transient thinking entry.
type BranchMeta = { id: string; parentId: string | null; index: number; count: number; isUser: boolean };
type RenderEntry = ThreadEntry & { node?: BranchMeta };

// In-flight turn overlay — rendered on top of the committed path while the
// server works, then replaced by real nodes on response.
type Pending =
  | { kind: "turn" | "edit" | "draft"; parentId: string | null; userText: string | null; steps: string[] }
  | { kind: "retry"; anchorId: string; steps: string[] };

// What a completed/failed turn needs to know to graft itself into the tree.
type TurnCtx =
  | { kind: "turn" | "edit" | "draft"; parentId: string | null; userText: string | null }
  | { kind: "retry"; anchorId: string };

// Server /completion response, including the new message ids for grafting.
type CompletionResp = {
  result?: CompletionResult;
  title?: string;
  userMessageId?: string;
  assistantMessageId?: string;
};

const ROOT_KEY = "__root__";
const pkey = (parentId: string | null) => parentId ?? ROOT_KEY;
const isLocalId = (id: string) => id.startsWith("local:");

function siblingsSorted(nodes: Map<string, ChatNode>, parentId: string | null): ChatNode[] {
  return [...nodes.values()].filter((n) => n.parentId === parentId).sort((a, b) => a.order - b.order);
}

/** Walk root→leaf, choosing the selected child at each branch point (newest by
 *  default). A `seen` guard stops a malformed cycle from hanging the render. */
function activePath(nodes: Map<string, ChatNode>, activeChild: Record<string, string>): ChatNode[] {
  const path: ChatNode[] = [];
  const seen = new Set<string>();
  let parentId: string | null = null;
  for (;;) {
    const sibs = siblingsSorted(nodes, parentId);
    if (sibs.length === 0) break;
    // Annotate explicitly: `parentId` is reassigned from `chosen.id` below, so
    // letting these infer forms a type cycle that `tsc -b` rejects (TS7022).
    const chosenId: string | undefined = activeChild[pkey(parentId)];
    const chosen: ChatNode | undefined =
      (chosenId ? sibs.find((s) => s.id === chosenId) : undefined) ?? sibs[sibs.length - 1];
    if (!chosen || seen.has(chosen.id)) break;
    seen.add(chosen.id);
    path.push(chosen);
    parentId = chosen.id;
  }
  return path;
}

function nodeToEntry(n: ChatNode, nodes: Map<string, ChatNode>): RenderEntry {
  const sibs = siblingsSorted(nodes, n.parentId);
  const meta: BranchMeta = {
    id: n.id, parentId: n.parentId,
    index: sibs.findIndex((s) => s.id === n.id), count: sibs.length, isUser: n.role === "user",
  };
  if (n.role === "user") return { role: "user", text: n.text ?? "", node: meta };
  if (n.prospects) return { role: "ai", summary: n.summary ?? "", prospects: n.prospects, node: meta };
  if (n.companies) return { role: "ai", summary: n.summary ?? "", companies: n.companies, node: meta };
  return { role: "ai", text: n.text ?? "", isError: n.isError, keyMissing: n.keyMissing, node: meta };
}

/** Project the tree (+ optional in-flight overlay) into the linear render list
 *  the thread UI consumes. */
function buildThread(nodes: Map<string, ChatNode>, activeChild: Record<string, string>, pending: Pending | null): RenderEntry[] {
  const path = activePath(nodes, activeChild);
  if (!pending) return path.map((n) => nodeToEntry(n, nodes));

  if (pending.kind === "retry") {
    const idx = path.findIndex((n) => n.id === pending.anchorId);
    const kept = idx >= 0 ? path.slice(0, idx + 1) : path;
    const entries: RenderEntry[] = kept.map((n) => nodeToEntry(n, nodes));
    entries.push({ role: "ai", thinking: true, steps: pending.steps });
    return entries;
  }
  // turn / edit / draft — anchor on the parent (inclusive), then optimistic
  // user bubble (when any) + the thinking row.
  let kept: ChatNode[] = [];
  if (pending.parentId != null) {
    const idx = path.findIndex((n) => n.id === pending.parentId);
    kept = idx >= 0 ? path.slice(0, idx + 1) : path;
  }
  const entries: RenderEntry[] = kept.map((n) => nodeToEntry(n, nodes));
  if (pending.userText != null) entries.push({ role: "user", text: pending.userText });
  entries.push({ role: "ai", thinking: true, steps: pending.steps });
  return entries;
}

/** Build the node shape for an assistant reply from a CompletionResult. */
function aiNodeFromResult(result: CompletionResult): Partial<ChatNode> {
  if (result.kind === "prospects") return { summary: result.summary, prospects: result.prospects };
  if (result.kind === "companies") return { summary: result.summary, companies: result.companies };
  if (result.kind === "text") return { text: result.content };
  return { text: `Drafted ${result.drafts.length} outreach message${result.drafts.length === 1 ? "" : "s"}.` };
}

/** Route a user message to a completion mode. Shared by fresh sends, edits,
 *  and retries so re-runs route identically to the original send.
 *   - find: a fresh research brief / person-background / site-scrape
 *   - discover_more: an explicit "more / again / N people" re-ask when a prior
 *     result + brief exist on this branch
 *   - followup: a filter/refinement on an existing result
 *   - else: the user's current search-mode toggle (find | network) */
function routeMode(
  text: string,
  opts: { havePriorResult: boolean; hasBrief: boolean; searchMode: "find" | "network" },
): "find" | "network" | "followup" | "discover_more" {
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;

  // A bare count ("100", "up to 50", "50 people") is the user answering a
  // "How many prospects would you like?" clarify. It must route to `find` so
  // the server folds it into the conversation brief and runs the search —
  // NOT to followup, which has no list to filter and replies "I'm not sure
  // what you mean by 100." (find.ts reconstructs fullBrief from history and
  // reads a lone number as the count answer.)
  const isBareCount = /^\s*(?:up\s+to\s+)?\d{1,4}\s*(?:people|persons?|prospects|companies|firms|contacts|leads?)?\s*$/i.test(text);
  if (isBareCount) return "find";

  // A long pasted ICP that contains an explicit find/identify directive is a
  // FRESH search, even in a chat that already has prospects. Without this it
  // hits `if (havePriorResult) return "followup"` below (the brief doesn't
  // start with a find-verb, so looksLikeFreshBrief misses it) and gets eaten
  // by the followup LLM instead of running the real Find clarify→search flow.
  // Guards against eating genuine followup filters: requires a find directive
  // AND a substantial brief AND that it does NOT open with a filter verb
  // ("only…", "remove…", "just the…") which signals refine-the-list intent.
  const hasFindDirective = /\b(?:find|identify|search\s+for|look\s+for|get\s+me|pull|source|build\s+(?:me\s+)?a\s+list|give\s+me\s+a\s+list)\b/i.test(text);
  const startsWithFilterVerb = /^\s*(?:only|just|remove|exclude|keep|filter|drop|narrow|of\s+those|from\s+(?:these|the\s+list)|show\s+(?:me\s+)?(?:only|just))\b/i.test(text);
  const looksLikeFreshIcp = wordCount >= 25 && hasFindDirective && !startsWithFilterVerb;
  if (looksLikeFreshIcp) return "find";

  const looksLikeFreshBrief =
    /^\s*(?:find\s+(?:me\s+)?|search(?:\s+for)?\s+|look\s+(?:for|up)\s+|get\s+me\s+|show\s+me\s+|give\s+me\s+|i\s+(?:want|need)\s+)/i.test(text) &&
    (wordCount >= 8 || /\b(?:ai|cto|coo|cfo|cro|cio|ceo|svp|vp\b|md\b|director|head\s+of|manager|founder|partner|chief|engineer|scientist|analyst|consultant|investor)\b/i.test(text));

  // A bare comma-separated list of names ("revolut, wise, monzo, etc.") with
  // no verb is the user handing us target firms to search — a refinement/new
  // search, NOT a filter. Without this it dead-ends at the followup
  // fallthrough and the user (who just named their targets) gets a "could you
  // clarify" loop. Guard against filter phrasings ("remove X, Y") and
  // questions so genuine followups aren't misrouted.
  const looksLikeNamedTargets =
    /,/.test(text) && wordCount <= 12 && !/\?/.test(text) &&
    !/^\s*(?:only|just|remove|exclude|keep|filter|drop|narrow|without|except)\b/i.test(text) &&
    !/\b(?:find|search|filter|show|get|give|which|who|what|how)\b/i.test(text);

  const wantsNewSearch =
    looksLikeFreshBrief ||
    looksLikeNamedTargets ||
    /\b(more|another|additional|further|elsewhere|on the (web|internet)|search the web|search the internet)\b/i.test(text) ||
    /\b(?:search(?:\s+(?:again|better|for|more))?|re[-\s]?search|look\s+up|dig\s+up|go\s+find)\b/i.test(text) ||
    /\b(?:better|deeper|broader|wider|proper|real)\s+(?:search|list|results?)\b/i.test(text) ||
    /\badd\s+(?:their|the)?\s*(?:linkedin|email|phone|location|title|bio|contact)s?\b/i.test(text) ||
    /\b(?:find|get|give|show|need|want)\s+(?:me\s+)?(?:up\s+to\s+)?\d{1,3}\b/i.test(text) ||
    // Imperative to act on named targets WITHOUT a count: "yes so find them",
    // "go find them", "find these people", "pull them". The named firms ride
    // in the conversation brief, so discover_more/find will target them.
    /\b(?:find|get|pull|surface|source|search\s+for)\s+(?:me\s+)?(?:them|these|those|the\s+(?:people|ones|rest))\b/i.test(text) ||
    /^\s*(?:no|nope|not (?:these|right|good|it)|actually|wait)\b/i.test(text) ||
    /\b(?:start over|redo|try again|different (?:search|prospects)|new search)\b/i.test(text);

  const wantsPersonBackground =
    /\b(?:background\s+(?:on|for|info)|deep[-\s]?dive\s+(?:on|into)|research\s+(?:on|about)|tell\s+me\s+(?:everything|more|all)\s+about|what\s+(?:do\s+you\s+know|can\s+you\s+find)\s+about|everything\s+(?:you\s+can\s+find\s+)?about|recent\s+(?:posts?|talks?|interviews?))\b/i.test(text);

  const wantsSiteScrape =
    /\b(?:scrape|crawl|extract\s+(?:from|the\s+content)|read|summari[sz]e)\b/i.test(text) &&
    /(?:https?:\/\/[^\s<>"']+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[\w./-]*)?)/i.test(text);

  if (wantsSiteScrape || wantsPersonBackground) return "find";
  if (opts.havePriorResult && wantsNewSearch && opts.hasBrief) return "discover_more";
  if (opts.havePriorResult) return "followup";
  return opts.searchMode;
}

/**
 * When sending chat-found prospects into a CRM board, carry their match
 * signals / match % / past roles / location as custom fields so the CRM
 * board actually shows WHY each lead matters.
 *
 * The custom column defs live in localStorage (same keys CRMView uses) so
 * the columns appear automatically when the user opens the board.
 */
const CHAT_CUSTOM_COLS: { id: string; label: string; width: string }[] = [
  { id: "c_signals", label: "Why relevant", width: "1.5fr" },
  { id: "c_match",   label: "Match %",     width: "80px"  },
  { id: "c_loc",     label: "Location",    width: "1fr"   },
  { id: "c_past",    label: "Past roles",  width: "1.3fr" },
];

function prospectToCustomFields(p: Prospect): Record<string, string> {
  const out: Record<string, string> = {};
  const signals = (p.signals ?? [])
    .map((s) => `${s.kind}: ${s.text}${s.when ? ` (${s.when})` : ""}`)
    .join(" · ");
  if (signals) out.c_signals = signals;
  if (typeof p.matchPct === "number" && p.matchPct > 0) out.c_match = `${p.matchPct}%`;
  if (p.loc) out.c_loc = p.loc;
  const past = (p.past ?? [])
    .slice(0, 2)
    .map((r) => `${r.role} @ ${r.co}${r.when ? ` (${r.when})` : ""}`)
    .join(" · ");
  if (past) out.c_past = past;
  return out;
}

/** Register the chat-origin custom columns on a board so they render the
 *  next time the CRM view loads it. Also flips them on in the visibility list. */
function ensureChatCustomCols(boardId: string) {
  if (!boardId) return;
  const customKey = `crm.customcols.v1.${boardId}`;
  const visKey = `crm.cols.v1.${boardId}`;
  try {
    const rawCustom = localStorage.getItem(customKey);
    const existing = rawCustom ? (JSON.parse(rawCustom) as { id: string }[]) : [];
    const existingIds = new Set(existing.map((c) => c.id));
    const toAdd = CHAT_CUSTOM_COLS.filter((c) => !existingIds.has(c.id));
    if (toAdd.length > 0) {
      localStorage.setItem(customKey, JSON.stringify([...existing, ...toAdd]));
    }
    // Also make sure they're visible.
    const rawVis = localStorage.getItem(visKey);
    if (rawVis) {
      const visible = JSON.parse(rawVis) as string[];
      const missing = CHAT_CUSTOM_COLS.map((c) => c.id).filter((id) => !visible.includes(id));
      if (missing.length > 0) {
        localStorage.setItem(visKey, JSON.stringify([...visible, ...missing]));
      }
    }
  } catch { /* swallow */ }
}

/** Small inline picker under a prospect result. Shows "Add all N to board…"
 *  which expands into a list of the user's CRM boards. Keeps the CRM-in-chat
 *  flow one click away instead of buried behind selection. */
function InlineAddAllToBoard({
  boards, count, onAdd,
}: {
  boards: CrmBoard[];
  count: number;
  onAdd: (boardId: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (count === 0) return null;
  return (
    <div style={{ position: "relative" }}>
      <button className="pill-btn primary" onClick={() => setOpen((o) => !o)} disabled={busy}>
        <IconUsers size={12} />Add all {count} to board
      </button>
      {open && (
        <>
          <div className="board-menu-bg" onClick={() => setOpen(false)} />
          {/* Opens upward — the button sits near the bottom of the results
              area whose ancestor container clips overflow. Anchoring to the
              bottom of the button keeps the board list on screen. */}
          <div className="board-menu" style={{ bottom: "calc(100% + 6px)", top: "auto", left: 0, right: "auto" }}>
            <div className="bm-label">Add {count} prospect{count === 1 ? "" : "s"} to…</div>
            {boards.length === 0 && (
              <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--text-mute)" }}>
                No boards yet — open the CRM tab to create one.
              </div>
            )}
            {boards.map((b) => (
              <button
                key={b.id}
                className="bm-item"
                onClick={async () => {
                  setBusy(true);
                  try { await onAdd(b.id); } finally { setBusy(false); setOpen(false); }
                }}
              >
                <span style={{ flex: 1, textAlign: "left" }}>{b.name}</span>
                <span className="board-count">{b.contactCount ?? 0}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Parse a server error message for missing-key mentions so we can render a
 *  friendlier "Add your keys" card instead of a raw error string. */
function detectMissingKeys(msg: string): KeyErrorHint | undefined {
  const needle = msg.toLowerCase();
  if (!needle.includes("key missing") && !needle.includes("_api_key not set") && !needle.includes("key not set")) {
    return undefined;
  }
  const providers: string[] = [];
  if (/tavily/i.test(msg)) providers.push("Tavily");
  if (/apollo/i.test(msg)) providers.push("Apollo");
  if (/openai/i.test(msg)) providers.push("OpenAI");
  if (/anthropic/i.test(msg)) providers.push("Anthropic");
  if (/deepseek/i.test(msg)) providers.push("DeepSeek");
  return { providers: providers.length ? providers : ["an AI"] };
}

const SEARCH_STEPS = ["Parsing intent…", "Searching the web…", "Extracting candidates…", "Ranking by match signals…"];
const NETWORK_STEPS = ["Parsing intent…", "Scanning your connections…", "Ranking matches…"];
const FOLLOWUP_STEPS = ["Reading prior results…", "Interpreting your request…"];
const DRAFT_STEPS = ["Reviewing recipient signals…", "Writing personalised drafts…"];

export function DiscoverPage() {
  const { user } = useAuth();
  const modal = useModal();
  const { buckets: usage, refresh: refreshUsage } = useUsage();

  const [chatId, setChatId] = useState<string | null>(null);
  const [activeNav, setActiveNav] = useState<string>("");
  const [searchMode, setSearchMode] = useState<"find" | "network">("find");
  // Per-search archetype-gate breadth. "broad" (default) accepts adjacent
  // senior roles in the same function family (e.g. Chief AI Officer when the
  // brief names "Head of AI"); "strict" matches only the exact roles named.
  const [matchBreadth, setMatchBreadth] = useState<"broad" | "strict">("broad");
  const [chatList, setChatList] = useState<ChatListItem[]>([]);
  const [lastBrief, setLastBrief] = useState<string>("");
  const [lastProspects, setLastProspects] = useState<Prospect[]>([]);
  // Names from the most recent COMPANIES result, so a follow-on people search
  // ("find the people in charge of AI within these companies") actually
  // targets them — otherwise the company list lives only in an assistant
  // result the server-side brief reconstruction never sees.
  const [lastCompanies, setLastCompanies] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [appMode, setAppMode] = useState<"discover" | "crm">("discover");
  const [crmViewMode, setCrmViewMode] = useState<"kanban" | "table" | "overview">("kanban");
  const [activeBoardId, setActiveBoardId] = useState<string>("");
  const [view, setView] = useState<"hero" | "thread">("hero");
  // Chat message tree (source of truth) + which sibling is active at each
  // branch point. The rendered `thread` is a pure projection of these.
  const [nodes, setNodes] = useState<Map<string, ChatNode>>(new Map());
  const [activeChild, setActiveChild] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  // Live search progress — replaces the canned "thinking" steps with the real
  // funnel note the server streams (discovered / qualified / filtered).
  const reportProgress = (note: string) =>
    setPending((p) => (p ? { ...p, steps: [note] } : p));
  // Monotonic order counter so the newest sibling is the default-active one.
  const orderRef = useRef(0);
  // Read current nodes synchronously inside async send handlers.
  const nodesRef = useRef(nodes);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  // Which user message is being edited inline (null = none), plus its draft text.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const thread = useMemo<RenderEntry[]>(() => buildThread(nodes, activeChild, pending), [nodes, activeChild, pending]);

  const resetTree = () => {
    setNodes(new Map());
    setActiveChild({});
    setPending(null);
    setEditingId(null);
    orderRef.current = 0;
  };
  /** The active leaf id — parent for the next normal follow-up turn. */
  const currentLeafId = (): string | null => {
    const path = activePath(nodesRef.current, activeChild);
    return path.length ? path[path.length - 1]!.id : null;
  };
  /** Graft a completed turn's server-assigned nodes into the tree and make
   *  that branch active. `assistantParentId` is the new user message (normal/
   *  edit) or the existing user message (retry). */
  const commitNodes = (args: {
    userMessageId?: string;
    userText?: string;
    userParentId?: string | null;
    assistantMessageId?: string;
    assistantParentId: string | null;
    result?: CompletionResult;
    errorText?: string;
    keyMissing?: KeyErrorHint;
  }) => {
    const o1 = orderRef.current++;
    const o2 = orderRef.current++;
    setNodes((prev) => {
      const next = new Map(prev);
      if (args.userMessageId) {
        next.set(args.userMessageId, {
          id: args.userMessageId, parentId: args.userParentId ?? null, order: o1,
          role: "user", text: args.userText ?? "",
        });
      }
      if (args.assistantMessageId) {
        const ai: ChatNode = {
          id: args.assistantMessageId, parentId: args.assistantParentId, order: o2, role: "ai",
        };
        if (args.errorText != null) { ai.text = args.errorText; ai.isError = true; ai.keyMissing = args.keyMissing; }
        else if (args.result) Object.assign(ai, aiNodeFromResult(args.result));
        next.set(args.assistantMessageId, ai);
      }
      return next;
    });
    setActiveChild((prev) => {
      const next = { ...prev };
      if (args.userMessageId) next[pkey(args.userParentId ?? null)] = args.userMessageId;
      if (args.assistantMessageId) next[pkey(args.assistantParentId)] = args.assistantMessageId;
      return next;
    });
    setPending(null);
  };
  const [draft, setDraft] = useState("");
  const draftRef = useRef<HTMLTextAreaElement>(null);
  // Auto-size the composer textarea: height tracks scrollHeight so the box
  // grows upward as the user adds lines and all text stays visible. Capped
  // at ~12 lines so a pathological paste doesn't eat the viewport.
  useLayoutEffect(() => {
    const el = draftRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [draft]);
  const [streaming, setStreaming] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openProspect, setOpenProspect] = useState<Prospect | null>(null);
  const [outreachFor, setOutreachFor] = useState<{ prospects: Prospect[]; drafts?: OutreachDraft[] } | null>(null);
  const [toast, setToast] = useState<{ msg: string; kind: "success" | "error" } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectionsImportOpen, setConnectionsImportOpen] = useState(false);
  const [boardMenuOpen, setBoardMenuOpen] = useState(false);
  const [boards, setBoards] = useState<CrmBoard[]>([]);

  // Chats are created LAZILY — only when the user actually sends a message.
  // Previously we auto-created on mount AND inside handleNewChat, which meant
  // clicking "New search" (and then never typing) left empty "New search"
  // rows cluttering the sidebar. sendSearch/sendDraft now ensure a chat exists.

  // Land on the CRM board on first load — the CRM is the home base, not the
  // empty search hero. Fires once; if the user navigates first, it's skipped.
  const didInitialLand = useRef(false);
  useEffect(() => {
    api.get<{ boards: CrmBoard[] }>("/api/crm/boards")
      .then((r) => {
        setBoards(r.boards);
        if (!didInitialLand.current && r.boards.length > 0) {
          didInitialLand.current = true;
          const b = r.boards[0]!;
          setActiveBoardId(b.id);
          setActiveNav(`board:${b.id}`);
          setAppMode("crm");
        }
      })
      .catch(() => { /* offline */ });
  }, []);

  const refreshChatList = () => {
    api.get<{ chats: ChatListItem[] }>("/api/chats")
      .then((r) => setChatList(r.chats ?? []))
      .catch(() => { /* offline */ });
  };
  useEffect(() => { refreshChatList(); }, []);

  const savedSearches = useMemo(
    () => chatList.slice(0, 20).map((c) => ({ id: c.id, label: c.title || "Untitled", count: 0 })),
    [chatList],
  );

  // Sidebar "Lists & segments" shows the user's CRM boards. Clicking one
  // jumps to the CRM view on that board — so the sidebar doubles as a
  // board picker without a second UI.
  const boardLists = useMemo(
    () => boards.map((b) => ({
      id: `board:${b.id}`,
      label: b.name,
      count: b.contactCount ?? 0,
    })),
    [boards],
  );

  const allProspects = useMemo(
    () => thread.flatMap((m) => ("prospects" in m ? m.prospects : [])),
    [thread],
  );

  const flash = (msg: string, kind?: "success" | "error") => {
    // Auto-detect failures so an error never shows a reassuring green check.
    const k = kind ?? (/\b(fail(ed|s)?|error|couldn'?t|could not|missing|invalid|denied|no match)\b/i.test(msg) ? "error" : "success");
    setToast({ msg, kind: k });
    setTimeout(() => setToast(null), k === "error" ? 4200 : 2800);
  };

  const handleNewChat = async () => {
    setAppMode("discover");
    setView("hero");
    resetTree();
    setSelected(new Set());
    setDraft("");
    setOpenProspect(null);
    setOutreachFor(null);
    setLastProspects([]);
    setLastBrief("");
    setLastCompanies([]);
    // Eagerly create a chat so it shows up in the sidebar immediately.
    // On first user message the title will be replaced via the same endpoint.
    try {
      const c = await api.post<{ id: string }>("/api/chats", { title: "New search" });
      setChatId(c.id);
      setActiveNav(c.id);
      // Append optimistically so the sidebar reflects it before the list fetch
      // finishes — avoids the "I clicked and nothing happened" feel.
      setChatList((cs) => [{ id: c.id, title: "New search", updated_at: new Date().toISOString() }, ...cs]);
      refreshChatList();
    } catch (err) {
      setChatId(null);
      setActiveNav("");
      flash(`New search failed: ${(err as Error).message}`);
    }
  };

  /** Ensure we have a chatId, creating one lazily on the user's first send. */
  async function ensureChatId(seedTitle?: string): Promise<string> {
    if (chatId) return chatId;
    const title = (seedTitle ?? "New search").slice(0, 80) || "New search";
    const c = await api.post<{ id: string }>("/api/chats", { title });
    setChatId(c.id);
    setActiveNav(c.id);
    refreshChatList();
    return c.id;
  }

  const renameChat = async (id: string, title: string) => {
    // Optimistic update.
    setChatList((cs) => cs.map((c) => (c.id === id ? { ...c, title } : c)));
    try {
      await api.patch(`/api/chats/${id}`, { title });
    } catch (err) {
      refreshChatList();
      flash(`Rename failed: ${(err as Error).message}`);
    }
  };

  const deleteChat = async (id: string) => {
    // Optimistic update.
    setChatList((cs) => cs.filter((c) => c.id !== id));
    try {
      await api.del(`/api/chats/${id}`);
      if (chatId === id) {
        setChatId(null);
        setActiveNav("");
        resetTree();
        setView("hero");
        setLastProspects([]);
        setLastBrief("");
        setLastCompanies([]);
      }
      flash("Search deleted");
    } catch (err) {
      refreshChatList();
      flash(`Delete failed: ${(err as Error).message}`);
    }
  };

  const handleNewBoard = async () => {
    const name = await modal.prompt({
      title: "New CRM board",
      label: "Board name",
      placeholder: "e.g. Outreach pipeline",
      defaultValue: "Untitled pipeline",
      confirmLabel: "Create board",
    });
    if (!name) return;
    try {
      const b = await api.post<CrmBoard>("/api/crm/boards", { name });
      const updated = [...boards, { ...b, contactCount: 0 }];
      setBoards(updated);
      setAppMode("crm");
      setActiveBoardId(b.id);
      setActiveNav(`board:${b.id}`);
      flash(`Created "${name}"`);
    } catch (e) {
      flash(`Create board failed: ${(e as Error).message}`);
    }
  };

  const renameBoard = async (navId: string, title: string) => {
    const id = navId.startsWith("board:") ? navId.slice(6) : navId;
    setBoards((bs) => bs.map((b) => (b.id === id ? { ...b, name: title } : b)));
    try {
      await api.patch(`/api/crm/boards/${id}`, { name: title });
    } catch (err) {
      flash(`Rename failed: ${(err as Error).message}`);
    }
  };

  const deleteBoardFromNav = async (navId: string) => {
    const id = navId.startsWith("board:") ? navId.slice(6) : navId;
    const target = boards.find((b) => b.id === id);
    const next = boards.filter((b) => b.id !== id);
    setBoards(next);
    if (activeBoardId === id) setActiveBoardId("");
    try {
      await api.del(`/api/crm/boards/${id}`);
      flash(`Deleted "${target?.name ?? "board"}"`);
      // The server auto-seeds a default board on the next GET /api/crm/boards
      // if none remain, so refetch to pick that up.
      if (next.length === 0) {
        const r = await api.get<{ boards: CrmBoard[] }>("/api/crm/boards");
        setBoards(r.boards);
      }
    } catch (err) {
      flash(`Delete failed: ${(err as Error).message}`);
    }
  };

  // Let users click a saved search in the sidebar to re-enter that chat,
  // OR a CRM list to jump to that board.
  const handleSelectNav = (id: string) => {
    setActiveNav(id);
    if (!id) return;
    // Board item: "board:<id>" → switch to CRM view on that board.
    if (id.startsWith("board:")) {
      const boardId = id.slice("board:".length);
      setAppMode("crm");
      setActiveBoardId(boardId);
      return;
    }
    // Chat row: switch to Discover and restore the conversation.
    if (!chatList.some((c) => c.id === id)) return;
    setAppMode("discover");
    setChatId(id);
    setLastProspects([]);
    setLastBrief("");
    setLastCompanies([]);
    resetTree();
    setView("hero");
    // Fetch messages — assistant messages include the full structured result
    // as JSON so prospect cards rebuild instead of becoming plain-text
    // summaries. parent_id drives the branch tree; ordering is by created_at.
    api.get<{ messages: { id: string; parent_id: string | null; role: string; content: string; result?: CompletionResult | null }[] }>(`/api/chats/${id}/messages`)
      .then((r) => {
        const rows = r.messages ?? [];
        const built = new Map<string, ChatNode>();
        rows.forEach((m, i) => {
          const node: ChatNode = {
            id: m.id, parentId: m.parent_id, order: i, role: m.role === "user" ? "user" : "ai",
          };
          if (m.role === "user") {
            node.text = m.content;
          } else {
            const res = m.result;
            if (res && typeof res === "object" && "kind" in res && res.kind === "prospects") {
              node.summary = res.summary; node.prospects = res.prospects;
            } else if (res && typeof res === "object" && "kind" in res && res.kind === "companies") {
              node.summary = res.summary; node.companies = res.companies;
            } else if (res && typeof res === "object" && "kind" in res && res.kind === "text") {
              node.text = res.content;
            } else {
              node.text = m.content; // drafts / legacy: render the timeline stub
            }
          }
          built.set(m.id, node);
        });
        orderRef.current = rows.length;
        setNodes(built);
        setActiveChild({}); // newest-by-default selects the latest branch
        // Restore follow-up context from the active (newest) branch so "More
        // results" + refinement work after reopening a past chat.
        const path = activePath(built, {});
        const lastProspectNode = [...path].reverse().find((n) => n.prospects);
        const lastUserNode = [...path].reverse().find((n) => n.role === "user");
        setLastProspects(lastProspectNode?.prospects ?? []);
        setLastBrief(lastUserNode?.text ?? "");
        setView(path.length > 0 ? "thread" : "hero");
      })
      .catch(() => { /* leave thread empty */ });
  };

  const toggleSel = (id: string) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };
  const clearSel = () => setSelected(new Set());

  async function sendSearch(override?: string) {
    const text = (override ?? draft).trim();
    if (!text || streaming) return;

    setDraft("");
    setView("thread");
    setStreaming(true);
    const isFirstMessage = thread.length === 0;
    const havePriorResult = lastProspects.length > 0;
    // Followup vs fresh-search routing. Trigger a fresh search whenever the
    // message reads as a re-ask, not a filter. Matches:
    // (Routing rules live in routeMode — fresh brief vs more/again vs filter.)
    const mode = routeMode(text, { havePriorResult, hasBrief: !!lastBrief, searchMode });

    // Server loads chat history from the DB and builds a full brief, so we
    // just send the latest turn. The new user message attaches under the
    // active leaf; the server returns ids we graft into the tree.
    const parentId = currentLeafId();
    const steps = mode === "network" ? NETWORK_STEPS : mode === "followup" ? FOLLOWUP_STEPS : SEARCH_STEPS;
    const ctx = { kind: "turn" as const, parentId, userText: text };
    setPending({ kind: "turn", parentId, userText: text, steps });

    try {
      const id = await ensureChatId(text);
      // If the user refers back to a prior COMPANIES result ("…within these
      // companies", "find people at these"), append the names so the server's
      // brief reconstruction actually targets them. The displayed message
      // stays clean (ctx.userText = text); only the sent/persisted content
      // carries the anchor.
      const refersToPriorCompanies =
        lastCompanies.length > 0 &&
        (mode === "find" || mode === "discover_more") &&
        /\b(these|those|them|above|the\s+(?:companies|firms|accounts|list))\b/i.test(text);
      // Phrasing matters: "only within … do not add other firms" trips the
      // server's looksLockedToNamedFirms, which skips firm-discovery (don't
      // waste budget re-deriving firms), keeps all named companies (no
      // slice-40 drop), and bypasses the buyer-filter so none are dropped.
      const companyAnchor = refersToPriorCompanies
        ? `\n\n(Search ONLY within these specific companies — do not add other firms: ${lastCompanies.join(", ")}.)`
        : "";
      const body: Record<string, unknown> = { content: `${text}${companyAnchor}`, mode, parentId, matchBreadth };
      if (mode === "followup") body.previousProspects = lastProspects;
      if (mode === "discover_more") {
        body.previousProspects = lastProspects;
        body.previousBrief = `${lastBrief}\n\nRefinement: ${text}${companyAnchor}`;
      }
      // Long budget: a single search now digs for up to ~2 min server-side.
      const resp = await api.completion<CompletionResp>(id, body, { onProgress: reportProgress });
      // On first send, rename the sidebar row NO MATTER WHAT — either to the
      // server's AI-generated title, or a truncated fallback so it never
      // stays stuck as "New search".
      if (isFirstMessage) {
        const nextTitle = (resp.title && resp.title.trim())
          ? resp.title.trim()
          : text.slice(0, 80);
        setChatList((cs) => cs.map((c) => (c.id === id ? { ...c, title: nextTitle } : c)));
        // Persist the fallback too so other sessions / re-fetches agree.
        if (!resp.title) {
          api.patch(`/api/chats/${id}`, { title: nextTitle }).catch(() => { /* non-fatal */ });
        }
      }
      commitResult(resp, ctx, mode === "discover_more" ? lastBrief : text);
    } catch (err) {
      commitError(err, ctx);
    } finally {
      setStreaming(false);
      refreshUsage();
    }
  }

  async function sendDiscoverMore() {
    if (streaming || lastProspects.length === 0) return;
    setStreaming(true);
    const content = "Show me more matches beyond the ones already listed.";
    const parentId = currentLeafId();
    const ctx = { kind: "turn" as const, parentId, userText: content };
    setPending({ kind: "turn", parentId, userText: content, steps: SEARCH_STEPS });
    try {
      const id = await ensureChatId(lastBrief);
      const resp = await api.completion<CompletionResp>(id, {
        content, mode: "discover_more", parentId, matchBreadth,
        previousProspects: lastProspects,
        previousBrief: lastBrief,
      }, { onProgress: reportProgress });
      commitResult(resp, ctx, lastBrief);
    } catch (err) {
      commitError(err, ctx);
    } finally {
      setStreaming(false);
      refreshUsage();
    }
  }

  async function sendDraft(recipients: Prospect[]) {
    setStreaming(true);
    const content = "Write personalised outreach for these recipients.";
    const parentId = currentLeafId();
    const ctx = { kind: "draft" as const, parentId, userText: content };
    setPending({ kind: "draft", parentId, userText: content, steps: DRAFT_STEPS });
    try {
      const id = await ensureChatId(lastBrief || "Outreach drafts");
      const resp = await api.completion<CompletionResp>(id, {
        content, mode: "draft", parentId, recipients,
      });
      commitResult(resp, ctx);
    } catch (err) {
      commitError(err, ctx);
    } finally {
      setStreaming(false);
      refreshUsage();
    }
  }

  /** Graft a thrown-error turn as a local (un-persisted) assistant node so the
   *  user sees the failure; it reconciles from the server on reload. */
  function commitError(err: unknown, ctx: TurnCtx) {
    const message = (err as Error).message ?? "Something went wrong.";
    const keyMissing = detectMissingKeys(message);
    if (ctx.kind === "retry") {
      commitNodes({ assistantMessageId: `local:a:${orderRef.current}`, assistantParentId: ctx.anchorId, errorText: message, keyMissing });
      return;
    }
    const uid = `local:u:${orderRef.current}`;
    commitNodes({
      userMessageId: uid, userText: ctx.userText ?? "", userParentId: ctx.parentId,
      assistantMessageId: `local:a:${orderRef.current}`, assistantParentId: uid,
      errorText: message, keyMissing,
    });
  }

  /** Graft a completed turn (server ids + result) into the tree and run the
   *  result's side effects (follow-up context, outreach modal). */
  function commitResult(resp: CompletionResp, ctx: TurnCtx, brief?: string) {
    const result = resp.result;
    // Defensive: if the server returned no/malformed result (an error envelope
    // slipping past the early header flush), show a soft error instead of
    // crashing on `result.kind`.
    if (!result || typeof result !== "object" || !("kind" in result)) {
      commitError(new Error("Something went wrong on the server — no result was returned. Try again, and if it keeps happening, check the API keys in Settings."), ctx);
      return;
    }
    if (ctx.kind === "retry") {
      commitNodes({ assistantMessageId: resp.assistantMessageId, assistantParentId: ctx.anchorId, result });
    } else {
      commitNodes({
        userMessageId: resp.userMessageId, userText: ctx.userText ?? "", userParentId: ctx.parentId,
        assistantMessageId: resp.assistantMessageId,
        assistantParentId: resp.userMessageId ?? ctx.parentId,
        result,
      });
    }
    // Track the latest prospect result so follow-ups / discover_more have
    // context. Keep the original brief around for discover_more to re-query.
    if (result.kind === "prospects") {
      setLastProspects(result.prospects);
      if (brief && brief !== "Show me more matches beyond the ones already listed.") {
        setLastBrief(brief);
      }
    }
    // Company results carry no prospects, but we still keep the brief so a
    // follow-up ("find more companies", "only US-HQ ones") has context, and
    // the company names so "find people within these companies" can target them.
    if (result.kind === "companies") {
      setLastCompanies(result.companies.map((c) => c.name).filter(Boolean));
      if (brief && brief !== "Show me more matches beyond the ones already listed.") {
        setLastBrief(brief);
      }
    }
    if (result.kind === "drafts") {
      const byId = new Map(allProspects.map((p) => [p.id, p]));
      const recipients = result.drafts.map((d) => byId.get(d.recipientId) ?? ({
        id: d.recipientId, name: d.recipientName, title: "", company: d.recipientCompany,
        signals: [], past: [], matchPct: 0,
      } as Prospect));
      setOutreachFor({ prospects: recipients, drafts: result.drafts });
    }
  }

  // ── Message actions: copy, version switch, edit (fork), retry ─────────────
  const stepsFor = (mode: "find" | "network" | "followup" | "discover_more") =>
    mode === "network" ? NETWORK_STEPS : mode === "followup" ? FOLLOWUP_STEPS : SEARCH_STEPS;

  /** Follow-up context (prior prospects + brief) from the active branch up to
   *  and including `parentId` — so an edit/retry routes + filters against what
   *  preceded it, not the current leaf. */
  const branchContextBefore = (parentId: string | null): { prospects: Prospect[]; brief: string } => {
    if (!parentId) return { prospects: [], brief: "" };
    const path = activePath(nodesRef.current, activeChild);
    const idx = path.findIndex((n) => n.id === parentId);
    const prefix = idx >= 0 ? path.slice(0, idx + 1) : path;
    const reversed = [...prefix].reverse();
    return {
      prospects: reversed.find((n) => n.prospects)?.prospects ?? [],
      brief: reversed.find((n) => n.role === "user")?.text ?? "",
    };
  };

  const copyToClipboard = (text: string, label: string) => {
    // Strip HTML so a copied AI summary (which can be markup) lands as plain
    // text rather than tags.
    const plain = text.includes("<") ? (() => { const d = document.createElement("div"); d.innerHTML = text; return d.textContent ?? text; })() : text;
    navigator.clipboard?.writeText(plain).then(() => flash(`Copied ${label}`)).catch(() => flash("Copy failed"));
  };

  /** Flip a branch point to its previous/next sibling. */
  const switchSibling = (parentId: string | null, dir: -1 | 1) => {
    const sibs = siblingsSorted(nodesRef.current, parentId);
    if (sibs.length < 2) return;
    const activeId = activeChild[pkey(parentId)] ?? sibs[sibs.length - 1]!.id;
    const i = sibs.findIndex((s) => s.id === activeId);
    const nextSib = sibs[Math.min(sibs.length - 1, Math.max(0, i + dir))];
    if (nextSib) setActiveChild((prev) => ({ ...prev, [pkey(parentId)]: nextSib.id }));
  };

  const startEdit = (nodeId: string, currentText: string) => {
    setEditingId(nodeId);
    setEditDraft(currentText);
  };
  const cancelEdit = () => { setEditingId(null); setEditDraft(""); };

  /** Submit an edited user message as a SIBLING branch (same parent), then run
   *  a completion under it — forking the conversation at that point. */
  async function submitEdit() {
    const id = editingId;
    const text = editDraft.trim();
    if (!id || !text || streaming || !chatId) return;
    const node = nodesRef.current.get(id);
    if (!node || isLocalId(id)) return;
    const parentId = node.parentId;
    setEditingId(null);
    setStreaming(true);
    const { prospects, brief } = branchContextBefore(parentId);
    const mode = routeMode(text, { havePriorResult: prospects.length > 0, hasBrief: !!brief, searchMode });
    const ctx = { kind: "edit" as const, parentId, userText: text };
    setPending({ kind: "edit", parentId, userText: text, steps: stepsFor(mode) });
    try {
      const body: Record<string, unknown> = { content: text, mode, parentId, matchBreadth };
      if (mode === "followup") body.previousProspects = prospects;
      if (mode === "discover_more") { body.previousProspects = prospects; body.previousBrief = `${brief}\n\nRefinement: ${text}`; }
      const resp = await api.completion<CompletionResp>(chatId, body);
      commitResult(resp, ctx, mode === "discover_more" ? brief : text);
    } catch (err) {
      commitError(err, ctx);
    } finally {
      setStreaming(false);
      refreshUsage();
    }
  }

  /** Regenerate the answer to a user message as a NEW sibling assistant. */
  async function retryAssistant(assistantNodeId: string) {
    if (streaming || !chatId) return;
    const aNode = nodesRef.current.get(assistantNodeId);
    if (!aNode || !aNode.parentId) return;
    const userNode = nodesRef.current.get(aNode.parentId);
    if (!userNode || userNode.role !== "user" || isLocalId(userNode.id)) return;
    const text = userNode.text ?? "";
    setStreaming(true);
    const { prospects, brief } = branchContextBefore(userNode.parentId);
    const mode = routeMode(text, { havePriorResult: prospects.length > 0, hasBrief: !!brief, searchMode });
    const ctx = { kind: "retry" as const, anchorId: userNode.id };
    setPending({ kind: "retry", anchorId: userNode.id, steps: stepsFor(mode) });
    try {
      const body: Record<string, unknown> = { content: text, mode, regenerateAssistantForUserId: userNode.id, matchBreadth };
      if (mode === "followup") body.previousProspects = prospects;
      if (mode === "discover_more") { body.previousProspects = prospects; body.previousBrief = brief; }
      const resp = await api.completion<CompletionResp>(chatId, body);
      commitResult(resp, ctx, mode === "discover_more" ? brief : text);
    } catch (err) {
      commitError(err, ctx);
    } finally {
      setStreaming(false);
      refreshUsage();
    }
  }

  /** Hover action row under a message: version switcher (when the message has
   *  sibling branches) + copy + edit (user) / retry (ai). */
  const renderMsgActions = (
    node: BranchMeta | undefined,
    opts: { copyText: string; copyLabel: string; kind: "user" | "ai" },
  ) => {
    if (!node) return null;
    return (
      <div className="msg-actions">
        {node.count > 1 && (
          <div className="version-switch" title={`Version ${node.index + 1} of ${node.count}`}>
            <button className="msg-act" aria-label="Previous version" onClick={() => switchSibling(node.parentId, -1)} disabled={node.index <= 0 || streaming}><IconChevL size={13} /></button>
            <span className="version-count">{node.index + 1}/{node.count}</span>
            <button className="msg-act" aria-label="Next version" onClick={() => switchSibling(node.parentId, 1)} disabled={node.index >= node.count - 1 || streaming}><IconChevR size={13} /></button>
          </div>
        )}
        <button className="msg-act" title="Copy" onClick={() => copyToClipboard(opts.copyText, opts.copyLabel)}><IconCopy size={13} /></button>
        {opts.kind === "user" && !isLocalId(node.id) && (
          <button className="msg-act" title="Edit" onClick={() => startEdit(node.id, opts.copyText)} disabled={streaming}><IconEdit size={13} /></button>
        )}
        {opts.kind === "ai" && !isLocalId(node.id) && (
          <button className="msg-act" title="Retry" onClick={() => retryAssistant(node.id)} disabled={streaming}><IconRetry size={13} /></button>
        )}
      </div>
    );
  };

  /** Create a fresh CRM board from the selected prospects. Real action — POSTs
   *  a board + bulk-inserts contacts, then switches the user to the new board. */
  const saveAsList = async () => {
    const chosen = allProspects.filter((p) => selected.has(p.id));
    if (chosen.length === 0) return;
    const name = await modal.prompt({
      title: "Save as CRM list",
      label: "List name",
      defaultValue: `Prospects · ${new Date().toLocaleDateString()}`,
      confirmLabel: "Save",
    });
    if (!name) return;
    try {
      const board = await api.post<CrmBoard>("/api/crm/boards", { name });
      ensureChatCustomCols(board.id);
      await api.post(`/api/crm/boards/${board.id}/contacts/bulk`, {
        contacts: chosen.map((p) => ({
          name: p.name,
          title: p.title,
          company: p.company,
          email: p.email ?? null,
          phone: p.phone ?? null,
          linkedin: p.linkedin ?? null,
          source: "Search — Saved list",
          stage: "new",
          temp: "warm",
          customFields: prospectToCustomFields(p),
        })),
      });
      const r = await api.get<{ boards: CrmBoard[] }>("/api/crm/boards");
      setBoards(r.boards);
      flash(`Saved ${chosen.length} to "${name}" — switch to CRM to view.`);
      clearSel();
    } catch (err) {
      flash(`Save failed: ${(err as Error).message}`);
    }
  };

  /** "Send to Sheets" — copies the CSV to the clipboard and opens a new
   *  Google Sheet. User pastes into A1. No Google OAuth required; works for
   *  anyone logged into Google in another tab. */
  const sendToSheets = async () => {
    const chosen = allProspects.filter((p) => selected.has(p.id));
    if (chosen.length === 0) return;
    const headers = ["Name", "Title", "Company", "Email", "Email Confidence", "Phone", "LinkedIn", "Location", "Headcount", "Funding", "Match %"];
    const rows = chosen.map((p) => [
      p.name, p.title, p.company, p.email ?? "", p.emailConf != null ? `${p.emailConf}%` : "",
      p.phone ?? "", p.linkedin ?? "", p.loc ?? "", p.headcount ?? "", p.funding ?? "", `${p.matchPct}%`,
    ]);
    // TSV is what Google Sheets expects on paste — tabs split into columns.
    const tsv = [headers, ...rows]
      .map((r) => r.map((v) => String(v).replace(/\t/g, " ")).join("\t"))
      .join("\n");
    try {
      await navigator.clipboard.writeText(tsv);
      window.open("https://sheets.new", "_blank", "noopener");
      flash(`Copied ${chosen.length} to clipboard — paste into the new sheet (⌘V).`);
    } catch {
      flash("Clipboard blocked by the browser — use Export CSV instead.");
    }
  };

  const exportCSV = () => {
    const chosen = allProspects.filter((p) => selected.has(p.id));
    if (chosen.length === 0) return;
    const headers = ["Name", "Title", "Company", "Email", "Email Confidence", "Phone", "LinkedIn", "Location", "Headcount", "Funding", "Match %"];
    const rows = chosen.map((p) => [
      p.name, p.title, p.company, p.email ?? "", p.emailConf != null ? `${p.emailConf}%` : "",
      p.phone ?? "", p.linkedin ?? "", p.loc ?? "", p.headcount ?? "", p.funding ?? "", `${p.matchPct}%`,
    ]);
    const csv = [headers, ...rows]
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nontrivial-prospects-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    flash(`Exported ${chosen.length} prospects to CSV`);
  };

  const draftOutreachFor = (ids?: string[]) => {
    const targetIds = ids ?? [...selected];
    if (targetIds.length === 0) return;
    const recipients = targetIds.map((id) => allProspects.find((p) => p.id === id)).filter((p): p is Prospect => !!p);
    setOpenProspect(null);
    setSelected(new Set(targetIds));
    sendDraft(recipients);
  };

  const addSelectedToBoard = async (boardId: string) => {
    const chosen = allProspects.filter((p) => selected.has(p.id));
    if (chosen.length === 0) return;
    try {
      ensureChatCustomCols(boardId);
      await api.post(`/api/crm/boards/${boardId}/contacts/bulk`, {
        contacts: chosen.map((p) => ({
          name: p.name,
          title: p.title,
          company: p.company,
          email: p.email ?? null,
          phone: p.phone ?? null,
          linkedin: p.linkedin ?? null,
          source: "Search — Discover",
          stage: "new",
          temp: "warm",
          nextStep: "First touch",
          customFields: prospectToCustomFields(p),
        })),
      });
      // Refresh board counts.
      const r = await api.get<{ boards: CrmBoard[] }>("/api/crm/boards");
      setBoards(r.boards);
      const board = r.boards.find((b) => b.id === boardId);
      flash(`Added ${chosen.length} to "${board?.name ?? "board"}"`);
      clearSel();
      setBoardMenuOpen(false);
    } catch (err) {
      flash(`Add to board failed: ${(err as Error).message}`);
    }
  };

  const sentOutreach = () => {
    const n = outreachFor?.prospects.length ?? 0;
    setOutreachFor(null);
    clearSel();
    flash(`Queued ${n} message${n === 1 ? "" : "s"} for send`);
  };

  const userInitials = (user?.name || user?.email || "You")
    .split(/\s+|@/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");

  // Breadcrumb reflects real state. For Discover chats, prefer the chat's
  // AI-generated title (same string the sidebar shows) over truncating the
  // user's raw prompt — the title lives in chatList keyed by chatId and
  // gets updated as soon as the server returns one from /completion.
  const breadcrumb = useMemo(() => {
    if (appMode === "crm") {
      // Always show the actual board name as the second crumb regardless
      // of whether the user is on the kanban or table view — switching
      // views is intra-board navigation, not a different page.
      const board = boardLists.find((b) => b.id === activeNav);
      return ["CRM", board?.label ?? "Board"];
    }
    if (view === "hero") return ["Discover", "New search"];
    const current = chatId ? chatList.find((c) => c.id === chatId) : undefined;
    if (current?.title && current.title !== "New search" && current.title !== "New chat") {
      return ["Discover", current.title];
    }
    const firstUser = thread.find((m): m is Extract<ThreadEntry, { role: "user" }> => m.role === "user")?.text;
    return ["Discover", firstUser ? firstUser.slice(0, 40) + (firstUser.length > 40 ? "…" : "") : "Untitled"];
  }, [appMode, activeNav, boardLists, view, thread, chatId, chatList]);

  return (
    <div className="stage">
      <div className="wallpaper light-bloom" />
      <div className={`app${collapsed ? " collapsed" : ""}`}>
        <Sidebar
          activeNav={activeNav}
          onSelect={handleSelectNav}
          onNewChat={handleNewChat}
          onRenameSearch={renameChat}
          onDeleteSearch={deleteChat}
          onNewBoard={handleNewBoard}
          onRenameBoard={renameBoard}
          onDeleteBoard={deleteBoardFromNav}
          savedSearches={savedSearches}
          lists={boardLists}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((c) => !c)}
          usage={usage}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <div className={`main${appMode === "crm" ? " crm" : ""}`}>
          <div className="topbar">
            <div className="crumbs">
              {appMode !== "crm" && (
                <>
                  <span>{breadcrumb[0]}</span>
                  <span className="crumb-sep">/</span>
                  <span className="cur">{breadcrumb[1]}</span>
                </>
              )}
            </div>
            <div className="top-actions">
              <button
                className="avatar-mini"
                title="Settings"
                onClick={() => setSettingsOpen(true)}
                style={{ cursor: "pointer" }}
              >
                {userInitials || "YS"}
              </button>
            </div>
          </div>

          <div className="canvas">
            {appMode === "crm" ? (
              <CRMView
                viewMode={crmViewMode}
                setViewMode={setCrmViewMode}
                onFlash={flash}
                activeBoardId={activeBoardId || undefined}
                onActiveBoardChange={setActiveBoardId}
                onBoardsChange={setBoards}
              />
            ) : view === "hero" ? (
              <div className="hero">
                <h1>Describe your <em>ideal prospect.</em></h1>
              </div>
            ) : (
              <div className="thread">
                {thread.map((m, i) => {
                  if (m.role === "user") {
                    const node = m.node;
                    const key = node?.id ?? `u${i}`;
                    if (node && editingId === node.id) {
                      return (
                        <div key={key} className="user-row editing">
                          <textarea
                            className="user-edit-input"
                            value={editDraft}
                            autoFocus
                            onChange={(e) => setEditDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitEdit(); }
                              if (e.key === "Escape") cancelEdit();
                            }}
                          />
                          <div className="user-edit-actions">
                            <button className="pill-btn" onClick={cancelEdit}>Cancel</button>
                            <button className="pill-btn primary" onClick={submitEdit} disabled={!editDraft.trim() || streaming}>Send</button>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div key={key} className="user-row">
                        <div className="user-msg">{m.text}</div>
                        {renderMsgActions(node, { copyText: m.text, copyLabel: "message", kind: "user" })}
                      </div>
                    );
                  }
                  if ("thinking" in m && m.thinking) {
                    const step = m.steps[Math.min(m.steps.length - 1, Math.floor((Date.now() / 600) % m.steps.length))];
                    return (
                      <div key={i} className="ai-block">
                        <div className="thinking-row">
                          <div className="think-spark"><IconSparkle size={15} /></div>
                          <span>{step}</span>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div key={m.node?.id ?? `a${i}`} className="ai-block">
                      {"summary" in m && m.summary && (
                        <div className="ai-summary" dangerouslySetInnerHTML={{ __html: m.summary }} />
                      )}
                      {"prospects" in m && (
                        <>
                          <ProspectGrid
                            prospects={m.prospects}
                            selected={selected}
                            onToggle={toggleSel}
                            onOpen={setOpenProspect}
                          />
                          {/* Result actions — only on the latest prospect block. */}
                          {i === thread.length - 1 && m.prospects.length > 0 && !streaming && (
                            <div className="result-actions">
                              {lastBrief && (
                                <button className="pill-btn" onClick={sendDiscoverMore}>
                                  <IconSearch size={12} />More results
                                </button>
                              )}
                              <InlineAddAllToBoard
                                boards={boards}
                                count={m.prospects.length}
                                onAdd={async (boardId) => {
                                  try {
                                    ensureChatCustomCols(boardId);
                                    await api.post(`/api/crm/boards/${boardId}/contacts/bulk`, {
                                      contacts: m.prospects.map((p) => ({
                                        name: p.name,
                                        title: p.title,
                                        company: p.company,
                                        email: p.email ?? null,
                                        phone: p.phone ?? null,
                                        linkedin: p.linkedin ?? null,
                                        source: "Chat — Discover",
                                        stage: "new",
                                        temp: "warm",
                                        customFields: prospectToCustomFields(p),
                                      })),
                                    });
                                    const r = await api.get<{ boards: CrmBoard[] }>("/api/crm/boards");
                                    setBoards(r.boards);
                                    const board = r.boards.find((b) => b.id === boardId);
                                    flash(`Added ${m.prospects.length} to "${board?.name ?? "board"}"`);
                                  } catch (err) {
                                    flash(`Add to board failed: ${(err as Error).message}`);
                                  }
                                }}
                              />
                              <span className="result-hint">
                                Type a filter or question below (e.g. "only those with email") to refine.
                              </span>
                            </div>
                          )}
                        </>
                      )}
                      {"companies" in m && (
                        <>
                          <CompanyGrid companies={m.companies} />
                          {i === thread.length - 1 && m.companies.length > 0 && !streaming && (
                            <div className="result-actions">
                              <span className="result-hint">
                                These are target accounts. Ask "find people at these companies" to pull contacts, or "find more companies" for another pass.
                              </span>
                            </div>
                          )}
                        </>
                      )}
                      {"text" in m && m.text && (
                        m.keyMissing ? (
                          <div className="key-missing-card">
                            <div className="kmc-icon"><IconSparkle size={14} /></div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div className="kmc-title">Connect a model to get started</div>
                              <div className="kmc-body">
                                Observable Intuition runs on your own API keys, so every search hits your own quota — nothing is stored on our side. Add a key from any one of:
                              </div>
                              <div className="kmc-providers">
                                <span className="kmc-provider">OpenAI</span>
                                <span className="kmc-provider">Claude (Anthropic)</span>
                                <span className="kmc-provider">DeepSeek</span>
                              </div>
                            </div>
                            <button className="pill-btn primary" onClick={() => setSettingsOpen(true)}>
                              Add a key
                            </button>
                          </div>
                        ) : (
                          // Text results that already carry HTML (network
                          // analysis, person-background, decision-maker
                          // narratives) need dangerouslySetInnerHTML so
                          // <p>/<strong>/<ul> render as markup instead of
                          // leaking tags into the chat bubble. Plain-text
                          // replies (clarify questions, error messages)
                          // render through React as before — they don't
                          // start with "<".
                          m.text.trim().startsWith("<") ? (
                            <div
                              className="ai-summary"
                              style={m.isError ? { color: "var(--danger)" } : undefined}
                              dangerouslySetInnerHTML={{ __html: m.text }}
                            />
                          ) : (
                            <div className="ai-summary" style={m.isError ? { color: "var(--danger)" } : undefined}>
                              {m.text}
                            </div>
                          )
                        )
                      )}
                      {renderMsgActions(m.node, {
                        copyText: "summary" in m && m.summary ? m.summary : ("text" in m && m.text ? m.text : ""),
                        copyLabel: "response",
                        kind: "ai",
                      })}
                    </div>
                  );
                })}

                {selected.size > 0 && (
                  <div className="selection-bar">
                    <div className="sel-count"><strong>{selected.size}</strong> selected</div>
                    <button className="pill-btn" onClick={clearSel}>Clear</button>
                    <div className="sel-spacer" />
                    <div className="sel-actions">
                      <div style={{ position: "relative" }}>
                        <button className="pill-btn" onClick={() => setBoardMenuOpen((o) => !o)}>
                          <IconUsers size={12} />Add to board
                        </button>
                        {boardMenuOpen && (
                          <>
                            <div className="board-menu-bg" onClick={() => setBoardMenuOpen(false)} />
                            <div className="board-menu" style={{ left: "auto", right: 0, bottom: "calc(100% + 6px)", top: "auto" }}>
                              <div className="bm-label">Add {selected.size} to…</div>
                              {boards.length === 0 && (
                                <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--text-mute)" }}>
                                  No boards yet — open the CRM tab to create one.
                                </div>
                              )}
                              {boards.map((b) => (
                                <button key={b.id} className="bm-item" onClick={() => addSelectedToBoard(b.id)}>
                                  <span style={{ flex: 1, textAlign: "left" }}>{b.name}</span>
                                  <span className="board-count">{b.contactCount ?? 0}</span>
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                      <button className="pill-btn" onClick={saveAsList}>
                        <IconSave size={12} />Save as list
                      </button>
                      <button className="pill-btn" onClick={exportCSV}>
                        <IconDownload size={12} />Export CSV
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {appMode === "discover" && (
            <div className="composer-wrap">
              <div className="composer">
                <div className="composer-row">
                  <div className="composer-spark">
                    <IconSparkle size={16} style={{ color: "var(--accent)" }} />
                  </div>
                  <textarea
                    ref={draftRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        sendSearch();
                      }
                    }}
                    placeholder={searchMode === "network" ? "Who in your network…" : "Describe your ideal prospect…"}
                    rows={1}
                  />
                </div>
                <div className="composer-tools">
                  <div className="tool-group">
                    <div className="mode-switch" style={{ marginRight: 8 }}>
                      <button
                        className={searchMode === "find" ? "active" : ""}
                        onClick={() => setSearchMode("find")}
                        title="Search the public web"
                      >
                        <IconSearch size={12} />Web
                      </button>
                      <button
                        className={searchMode === "network" ? "active" : ""}
                        onClick={() => setSearchMode("network")}
                        title="Search your own LinkedIn connections"
                      >
                        <IconUsers size={12} />My network
                      </button>
                    </div>
                    {/* Archetype-match breadth — only relevant for web search,
                        which runs the archetype gate. Broad accepts adjacent
                        senior roles; Strict matches only the exact roles. */}
                    {searchMode === "find" && (
                      <div className="mode-switch" style={{ marginRight: 8 }}>
                        <button
                          className={matchBreadth === "broad" ? "active" : ""}
                          onClick={() => setMatchBreadth("broad")}
                          title="Accept adjacent senior roles in the same function family (more results)"
                        >
                          Broad
                        </button>
                        <button
                          className={matchBreadth === "strict" ? "active" : ""}
                          onClick={() => setMatchBreadth("strict")}
                          title="Match only the exact roles named in your brief (fewer, tighter results)"
                        >
                          Strict
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="send-group">
                    <button
                      className="send"
                      onClick={() => sendSearch()}
                      disabled={streaming || !draft.trim()}
                    >
                      <IconArrowUp size={14} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {openProspect && (
        <DetailDrawer
          prospect={openProspect}
          index={allProspects.findIndex((p) => p.id === openProspect.id)}
          onClose={() => setOpenProspect(null)}
          onDraft={draftOutreachFor}
        />
      )}
      {outreachFor && (
        <OutreachDrawer
          recipients={outreachFor.prospects}
          drafts={outreachFor.drafts}
          onClose={() => setOutreachFor(null)}
          onSent={sentOutreach}
        />
      )}
      <SettingsDrawer
        open={settingsOpen}
        usage={usage}
        onClose={() => setSettingsOpen(false)}
        onFlash={flash}
        onImportLinkedIn={() => { setSettingsOpen(false); setConnectionsImportOpen(true); }}
        onBoardJoined={async (boardId) => {
          try {
            const r = await api.get<{ boards: CrmBoard[] }>("/api/crm/boards");
            setBoards(r.boards);
          } catch { /* noop */ }
          setSettingsOpen(false);
          setAppMode("crm");
          setActiveBoardId(boardId);
          setActiveNav(`board:${boardId}`);
        }}
      />
      {connectionsImportOpen && (
        <ConnectionsImportModal
          onClose={() => setConnectionsImportOpen(false)}
          onFlash={flash}
        />
      )}
      {toast && (
        <div className={`toast toast-${toast.kind}`}>
          {toast.kind === "error"
            ? <span className="toast-ico" aria-hidden><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.6}><circle cx="7" cy="7" r="5.5" /><line x1="7" y1="4" x2="7" y2="7.5" /><circle cx="7" cy="10" r="0.6" fill="currentColor" stroke="none" /></svg></span>
            : <IconCheck size={14} />}
          {toast.msg}
        </div>
      )}
    </div>
  );
}
