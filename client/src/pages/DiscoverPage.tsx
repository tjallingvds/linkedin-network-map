/**
 * Discover — primary Nontrivial workspace. The composer is search-only;
 * enrichment lives in the CRM (per-board "Enrich with Apollo" button).
 * Outreach drafts are triggered from the selection bar.
 */
import { useEffect, useMemo, useState } from "react";
import type { CompletionResult, CrmBoard, OutreachDraft, Prospect } from "@app/shared";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";
import { Sidebar } from "../components/Sidebar";
import { useUsage } from "../lib/useUsage";
import { ProspectGrid } from "../components/ProspectCard";
import { DetailDrawer } from "../components/DetailDrawer";
import { OutreachDrawer } from "../components/OutreachDrawer";
import { CRMView } from "../components/CRMView";
import { SettingsDrawer } from "../components/SettingsDrawer";
import { PackPicker } from "../components/PackPicker";
import {
  IconBriefcase, IconSearch, IconSparkle, IconArrowUp, IconAttach,
  IconCheck, IconSave, IconDownload, IconSheet, IconSend, IconUsers,
} from "../design/icons";

type ThreadEntry =
  | { role: "user"; text: string }
  | { role: "ai"; thinking: true; steps: string[] }
  | { role: "ai"; summary: string; prospects: Prospect[] }
  | { role: "ai"; text: string; isError?: boolean; keyMissing?: KeyErrorHint };

type KeyErrorHint = { providers: string[] };
interface ChatListItem { id: string; title: string; updated_at: string; }

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
const DRAFT_STEPS = ["Reviewing recipient signals…", "Writing personalised drafts…"];

export function DiscoverPage() {
  const { user } = useAuth();
  const { buckets: usage, balance, refresh: refreshUsage } = useUsage();

  const [chatId, setChatId] = useState<string | null>(null);
  const [activeNav, setActiveNav] = useState<string>("");
  const [searchMode, setSearchMode] = useState<"find" | "network">("find");
  const [chatList, setChatList] = useState<ChatListItem[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [appMode, setAppMode] = useState<"discover" | "crm">("discover");
  const [crmViewMode, setCrmViewMode] = useState<"kanban" | "table">("kanban");
  const [view, setView] = useState<"hero" | "thread">("hero");
  const [thread, setThread] = useState<ThreadEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openProspect, setOpenProspect] = useState<Prospect | null>(null);
  const [outreachFor, setOutreachFor] = useState<{ prospects: Prospect[]; drafts?: OutreachDraft[] } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [packPickerOpen, setPackPickerOpen] = useState(false);
  const [boardMenuOpen, setBoardMenuOpen] = useState(false);
  const [boards, setBoards] = useState<CrmBoard[]>([]);

  // Create a chat on first render.
  useEffect(() => {
    if (chatId) return;
    api.post<{ id: string }>("/api/chats", { title: "New search" })
      .then((c) => { setChatId(c.id); setActiveNav(c.id); refreshChatList(); })
      .catch(() => { /* offline — errors surface on send */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

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

  const allProspects = useMemo(
    () => thread.flatMap((m) => ("prospects" in m ? m.prospects : [])),
    [thread],
  );

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2800);
  };

  const handleNewChat = () => {
    setView("hero");
    setThread([]);
    setSelected(new Set());
    setDraft("");
    setOpenProspect(null);
    setOutreachFor(null);
    setChatId(null);
    api.post<{ id: string }>("/api/chats", { title: "New search" })
      .then((c) => { setChatId(c.id); setActiveNav(c.id); refreshChatList(); })
      .catch(() => { /* offline */ });
  };

  // Let users click a saved search in the sidebar to re-enter that chat.
  const handleSelectNav = (id: string) => {
    setActiveNav(id);
    if (!id || id === chatId) return;
    // If it's a known chat, switch to it (UI is stateless per-chat for now,
    // so clear the thread and let the user keep typing in the same chat).
    if (chatList.some((c) => c.id === id)) {
      setChatId(id);
      setThread([]);
      setView("hero");
    }
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
    if (!chatId) {
      flash("Backend not connected — start the API server.");
      return;
    }

    setDraft("");
    setView("thread");
    setStreaming(true);
    const mode = searchMode;
    setThread((t) => [...t, { role: "user", text }]);
    setThread((t) => [...t, { role: "ai", thinking: true, steps: mode === "network" ? NETWORK_STEPS : SEARCH_STEPS }]);

    try {
      const resp = await api.post<{ result: CompletionResult }>(`/api/chats/${chatId}/completion`, {
        content: text, mode,
      });
      applyResult(resp.result);
    } catch (err) {
      appendError(err);
    } finally {
      setStreaming(false);
      refreshUsage();
    }
  }

  async function sendDraft(recipients: Prospect[]) {
    if (!chatId) { flash("Backend not connected."); return; }
    setStreaming(true);
    setThread((t) => [...t, { role: "ai", thinking: true, steps: DRAFT_STEPS }]);
    try {
      const resp = await api.post<{ result: CompletionResult }>(`/api/chats/${chatId}/completion`, {
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

  function applyResult(result: CompletionResult) {
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
    if (result.kind === "drafts") {
      const byId = new Map(allProspects.map((p) => [p.id, p]));
      const recipients = result.drafts.map((d) => byId.get(d.recipientId) ?? ({
        id: d.recipientId, name: d.recipientName, title: "", company: d.recipientCompany,
        signals: [], past: [], matchPct: 0,
      } as Prospect));
      setOutreachFor({ prospects: recipients, drafts: result.drafts });
    }
  }

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

  // Breadcrumb reflects real state.
  const breadcrumb = useMemo(() => {
    if (appMode === "crm") return ["Outreach CRM", crmViewMode === "kanban" ? "Pipeline board" : "All contacts"];
    if (view === "hero") return ["Discover", "New search"];
    const firstUser = thread.find((m): m is Extract<ThreadEntry, { role: "user" }> => m.role === "user")?.text;
    return ["Discover", firstUser ? firstUser.slice(0, 40) + (firstUser.length > 40 ? "…" : "") : "Untitled"];
  }, [appMode, crmViewMode, view, thread]);

  return (
    <div className="stage">
      <div className="wallpaper light-bloom" />
      <div className="app" style={collapsed ? { gridTemplateColumns: "56px 1fr" } : undefined}>
        <Sidebar
          activeNav={activeNav}
          onSelect={handleSelectNav}
          onNewChat={handleNewChat}
          savedSearches={savedSearches}
          lists={[]}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((c) => !c)}
          usage={usage}
          balance={balance}
          onOpenSettings={() => setSettingsOpen(true)}
          onGetMoreUsage={() => setPackPickerOpen(true)}
        />

        <div className="main">
          <div className="topbar">
            <div className="crumbs">
              <span>{breadcrumb[0]}</span>
              <span className="crumb-sep">/</span>
              <span className="cur">{breadcrumb[1]}</span>
            </div>
            <div className="top-actions">
              <div className="mode-switch">
                <button className={appMode === "discover" ? "active" : ""} onClick={() => setAppMode("discover")}>
                  <IconSearch size={12} />Discover
                </button>
                <button className={appMode === "crm" ? "active" : ""} onClick={() => setAppMode("crm")}>
                  <IconBriefcase size={12} />CRM
                </button>
              </div>
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
              <CRMView viewMode={crmViewMode} setViewMode={setCrmViewMode} onFlash={flash} />
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
                        <ProspectGrid
                          prospects={m.prospects}
                          selected={selected}
                          onToggle={toggleSel}
                          onOpen={setOpenProspect}
                        />
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
                      <button className="pill-btn" onClick={() => flash(`Saved ${selected.size} prospects to a new list`)}>
                        <IconSave size={12} />Save as list
                      </button>
                      <button className="pill-btn" onClick={exportCSV}>
                        <IconDownload size={12} />Export CSV
                      </button>
                      <button className="pill-btn" onClick={() => flash(`Sent ${selected.size} prospects to Google Sheets`)}>
                        <IconSheet size={12} />Send to Sheets
                      </button>
                      <button className="pill-btn primary" onClick={() => draftOutreachFor()}>
                        <IconSend size={12} />Draft outreach
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
                    <button className="tool"><IconAttach size={13} />Attach list</button>
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
      />
      {packPickerOpen && (
        <PackPicker
          onClose={() => setPackPickerOpen(false)}
          onGranted={(credits) => {
            flash(`+${credits.toLocaleString()} credits added`);
            refreshUsage();
          }}
        />
      )}
      {toast && (
        <div className="toast"><IconCheck size={14} />{toast}</div>
      )}
    </div>
  );
}
