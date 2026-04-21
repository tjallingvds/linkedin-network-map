/**
 * Discover — primary Nontrivial workspace. The composer is search-only;
 * enrichment lives in the CRM (per-board "Enrich with Apollo" button).
 * Outreach drafts are triggered from the selection bar.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CompletionResult, CrmBoard, OutreachDraft, Prospect } from "@app/shared";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";
import { useModal } from "../components/Modal";
import { Sidebar } from "../components/Sidebar";
import { useUsage } from "../lib/useUsage";
import { ProspectGrid } from "../components/ProspectCard";
import { DetailDrawer } from "../components/DetailDrawer";
import { OutreachDrawer } from "../components/OutreachDrawer";
import { CRMView } from "../components/CRMView";
import { SettingsDrawer } from "../components/SettingsDrawer";
import { ConnectionsImportModal } from "../components/ConnectionsImportModal";
import {
  IconSearch, IconSparkle, IconArrowUp,
  IconCheck, IconSave, IconDownload, IconSheet, IconSend, IconUsers,
} from "../design/icons";

type ThreadEntry =
  | { role: "user"; text: string }
  | { role: "ai"; thinking: true; steps: string[] }
  | { role: "ai"; summary: string; prospects: Prospect[] }
  | { role: "ai"; text: string; isError?: boolean; keyMissing?: KeyErrorHint };

type KeyErrorHint = { providers: string[] };
interface ChatListItem { id: string; title: string; updated_at: string; }

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
                <span style={{ fontSize: 15 }}>{b.emoji}</span>
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
  const [chatList, setChatList] = useState<ChatListItem[]>([]);
  const [lastBrief, setLastBrief] = useState<string>("");
  const [lastProspects, setLastProspects] = useState<Prospect[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [appMode, setAppMode] = useState<"discover" | "crm">("discover");
  const [crmViewMode, setCrmViewMode] = useState<"kanban" | "table">("kanban");
  const [activeBoardId, setActiveBoardId] = useState<string>("");
  const [view, setView] = useState<"hero" | "thread">("hero");
  const [thread, setThread] = useState<ThreadEntry[]>([]);
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
  const [toast, setToast] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectionsImportOpen, setConnectionsImportOpen] = useState(false);
  const [boardMenuOpen, setBoardMenuOpen] = useState(false);
  const [boards, setBoards] = useState<CrmBoard[]>([]);

  // Chats are created LAZILY — only when the user actually sends a message.
  // Previously we auto-created on mount AND inside handleNewChat, which meant
  // clicking "New search" (and then never typing) left empty "New search"
  // rows cluttering the sidebar. sendSearch/sendDraft now ensure a chat exists.

  // Load boards so the "Add to board" menu has options.
  useEffect(() => {
    api.get<{ boards: CrmBoard[] }>("/api/crm/boards")
      .then((r) => setBoards(r.boards))
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
      label: `${b.emoji} ${b.name}`,
      count: b.contactCount ?? 0,
    })),
    [boards],
  );

  const allProspects = useMemo(
    () => thread.flatMap((m) => ("prospects" in m ? m.prospects : [])),
    [thread],
  );

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2800);
  };

  const handleNewChat = async () => {
    setAppMode("discover");
    setView("hero");
    setThread([]);
    setSelected(new Set());
    setDraft("");
    setOpenProspect(null);
    setOutreachFor(null);
    setLastProspects([]);
    setLastBrief("");
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
        setThread([]);
        setView("hero");
        setLastProspects([]);
        setLastBrief("");
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
      const b = await api.post<CrmBoard>("/api/crm/boards", { name, emoji: "📣" });
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
    setThread([]);
    setView("hero");
    // Fetch messages — assistant messages include the full structured result
    // as JSON so prospect cards rebuild instead of becoming plain-text summaries.
    api.get<{ messages: { role: string; content: string; result?: CompletionResult | null }[] }>(`/api/chats/${id}/messages`)
      .then((r) => {
        const entries: ThreadEntry[] = [];
        let lastProspectBatch: Prospect[] = [];
        let lastBriefFromHistory = "";
        for (const m of r.messages ?? []) {
          if (m.role === "user") {
            entries.push({ role: "user" as const, text: m.content });
            lastBriefFromHistory = m.content;
          } else {
            // Prefer the structured payload when present.
            const res = m.result;
            if (res && typeof res === "object" && "kind" in res) {
              if (res.kind === "prospects") {
                entries.push({ role: "ai" as const, summary: res.summary, prospects: res.prospects });
                lastProspectBatch = res.prospects;
                continue;
              }
              if (res.kind === "text") {
                entries.push({ role: "ai" as const, text: res.content });
                continue;
              }
              // "drafts" don't render in the thread in the legacy UI — fall through.
            }
            entries.push({ role: "ai" as const, text: m.content });
          }
        }
        setThread(entries);
        setView(entries.length > 0 ? "thread" : "hero");
        // Restore follow-up context so "More results" + refinement work after
        // reopening a past chat.
        setLastProspects(lastProspectBatch);
        setLastBrief(lastBriefFromHistory);
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
    // If the user says things like "find more", "search the web", "on the
    // internet" after a result, they mean a fresh search — not a filter.
    const wantsNewSearch = /\b(more|another|additional|further|elsewhere|on the (web|internet)|search the web|search the internet)\b/i.test(text);

    let mode: "find" | "network" | "followup" | "discover_more";
    if (havePriorResult && wantsNewSearch && lastBrief) mode = "discover_more";
    else if (havePriorResult) mode = "followup";
    else mode = searchMode;

    // Server loads chat history from the DB and builds a full brief, so we
    // just send the latest turn.

    setThread((t) => [
      ...t,
      { role: "user", text },
      { role: "ai", thinking: true, steps:
          mode === "network" ? NETWORK_STEPS :
          mode === "followup" ? FOLLOWUP_STEPS :
          SEARCH_STEPS,
      },
    ]);

    try {
      const id = await ensureChatId(text);
      const body: Record<string, unknown> = { content: text, mode };
      if (mode === "followup") body.previousProspects = lastProspects;
      if (mode === "discover_more") {
        body.previousProspects = lastProspects;
        body.previousBrief = `${lastBrief}\n\nRefinement: ${text}`;
      }
      const resp = await api.post<{ result: CompletionResult; title?: string }>(`/api/chats/${id}/completion`, body);
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
      applyResult(resp.result, mode === "discover_more" ? lastBrief : text);
    } catch (err) {
      appendError(err);
    } finally {
      setStreaming(false);
      refreshUsage();
    }
  }

  async function sendDiscoverMore() {
    if (streaming || lastProspects.length === 0) return;
    setStreaming(true);
    setThread((t) => [...t, { role: "ai", thinking: true, steps: SEARCH_STEPS }]);
    try {
      const id = await ensureChatId(lastBrief);
      const resp = await api.post<{ result: CompletionResult }>(`/api/chats/${id}/completion`, {
        content: "Show me more matches beyond the ones already listed.",
        mode: "discover_more",
        previousProspects: lastProspects,
        previousBrief: lastBrief,
      });
      applyResult(resp.result, lastBrief);
    } catch (err) {
      appendError(err);
    } finally {
      setStreaming(false);
      refreshUsage();
    }
  }

  async function sendDraft(recipients: Prospect[]) {
    setStreaming(true);
    setThread((t) => [...t, { role: "ai", thinking: true, steps: DRAFT_STEPS }]);
    try {
      const id = await ensureChatId(lastBrief || "Outreach drafts");
      const resp = await api.post<{ result: CompletionResult }>(`/api/chats/${id}/completion`, {
        content: "Write personalised outreach for these recipients.",
        mode: "draft",
        recipients,
      });
      applyResult(resp.result);
    } catch (err) {
      appendError(err);
    } finally {
      setStreaming(false);
      refreshUsage();
    }
  }

  function appendError(err: unknown) {
    const message = (err as Error).message ?? "Something went wrong.";
    // Detect missing-key errors so we can render a nicer "Add your keys" card.
    const keyHint = detectMissingKeys(message);
    setThread((t) => {
      const copy = t.slice();
      const last = copy[copy.length - 1];
      if (last && "thinking" in last && last.thinking) copy.pop();
      copy.push({ role: "ai", text: message, isError: true, keyMissing: keyHint });
      return copy;
    });
  }

  function applyResult(result: CompletionResult, brief?: string) {
    setThread((t) => {
      const copy = t.slice();
      const last = copy[copy.length - 1];
      if (last && "thinking" in last && last.thinking) copy.pop();
      if (result.kind === "prospects") {
        copy.push({ role: "ai", summary: result.summary, prospects: result.prospects });
      } else if (result.kind === "text") {
        copy.push({ role: "ai", text: result.content });
      }
      return copy;
    });
    // Track the latest prospect result so follow-ups / discover_more have
    // context. Keep the original brief around for discover_more to re-query.
    if (result.kind === "prospects") {
      setLastProspects(result.prospects);
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
      const board = await api.post<CrmBoard>("/api/crm/boards", { name, emoji: "✨" });
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
    if (appMode === "crm") return ["Outreach CRM", crmViewMode === "kanban" ? "Pipeline board" : "All contacts"];
    if (view === "hero") return ["Discover", "New search"];
    const current = chatId ? chatList.find((c) => c.id === chatId) : undefined;
    if (current?.title && current.title !== "New search" && current.title !== "New chat") {
      return ["Discover", current.title];
    }
    const firstUser = thread.find((m): m is Extract<ThreadEntry, { role: "user" }> => m.role === "user")?.text;
    return ["Discover", firstUser ? firstUser.slice(0, 40) + (firstUser.length > 40 ? "…" : "") : "Untitled"];
  }, [appMode, crmViewMode, view, thread, chatId, chatList]);

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

        <div className="main">
          <div className="topbar">
            <div className="crumbs">
              <span>{breadcrumb[0]}</span>
              <span className="crumb-sep">/</span>
              <span className="cur">{breadcrumb[1]}</span>
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
                <div className="hero-eyebrow">Prospecting · Enrichment · Outreach</div>
                <div className="orb-wrap"><div className={`orb ${streaming ? "thinking" : ""}`} /></div>
                <h1>Describe your <em>ideal prospect.</em></h1>
              </div>
            ) : (
              <div className="thread">
                {thread.map((m, i) => {
                  if (m.role === "user") return <div key={i} className="user-msg">{m.text}</div>;
                  if ("thinking" in m && m.thinking) {
                    const step = m.steps[Math.min(m.steps.length - 1, Math.floor((Date.now() / 600) % m.steps.length))];
                    return (
                      <div key={i} className="ai-block">
                        <div className="ai-header"><div className="ai-avatar" /><span>Nontrivial</span></div>
                        <div className="thinking-row">
                          <div className="dots"><div className="dot" /><div className="dot" /><div className="dot" /></div>
                          <span>{step}</span>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div key={i} className="ai-block">
                      <div className="ai-header"><div className="ai-avatar" /><span>Nontrivial</span></div>
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
                      {"text" in m && m.text && (
                        m.keyMissing ? (
                          <div className="key-missing-card">
                            <div className="kmc-icon"><IconSparkle size={14} /></div>
                            <div style={{ flex: 1 }}>
                              <div className="kmc-title">Add your {m.keyMissing.providers.join(" + ")} key to get started</div>
                              <div className="kmc-body">
                                Nontrivial uses your own API keys so your searches hit your own quota — nothing is stored on our servers.
                              </div>
                            </div>
                            <button className="pill-btn primary" onClick={() => setSettingsOpen(true)}>
                              Add keys
                            </button>
                          </div>
                        ) : (
                          <div className="ai-summary" style={m.isError ? { color: "var(--danger)" } : undefined}>
                            {m.text}
                          </div>
                        )
                      )}
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
                                  <span style={{ fontSize: 15 }}>{b.emoji}</span>
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
        <div className="toast"><IconCheck size={14} />{toast}</div>
      )}
    </div>
  );
}
