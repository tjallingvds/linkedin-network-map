import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bar, BarChart, CartesianGrid, Cell, Legend,
  Line, LineChart, Pie, PieChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import { marked } from "marked";
import { IconArrowR, IconClose, IconUpload, IconSparkle } from "../design/icons";
import { api } from "../lib/api";

marked.setOptions({ breaks: true, gfm: true });
import {
  parseLinkedIn,
  parseLinkedInMessages,
  type NetworkImportRow,
  type MessageImportRow,
  type ParsedMessages,
} from "../lib/linkedinCsv";

// ---------- types ----------

interface UploadRow {
  id: string;
  team_member_name: string;
  detected_user_name: string | null;
  connections_count: number;
  messages_count: number;
  created_at: string;
}

interface ChartSpec {
  kind: "bar" | "pie" | "line" | "number";
  title: string;
  metric: string;
  data: { label: string; value: number }[];
}

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  charts?: ChartSpec[];
  suggestedTitle?: string;
}

interface PinnedRow {
  id: string;
  title: string;
  question: string | null;
  spec: ChartSpec;
  position: number;
  created_at: string;
}

const PIE_COLORS = ["#5e8b7e", "#a7c4bc", "#dfeeea", "#f5b8a3", "#c9a8d4", "#e6c89a"];

// ---------- main page ----------

export function SalesAnalysisPage() {
  const navigate = useNavigate();
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [pinned, setPinned] = useState<PinnedRow[]>([]);
  const [showUpload, setShowUpload] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const refreshAll = async () => {
    try {
      const [u, p] = await Promise.all([
        api.get<{ uploads: UploadRow[] }>("/api/sales/uploads"),
        api.get<{ pinned: PinnedRow[] }>("/api/sales/pinned"),
      ]);
      setUploads(u.uploads);
      setPinned(p.pinned);
    } catch (e) {
      setFlash(`Load failed: ${(e as Error).message}`);
    }
  };

  useEffect(() => {
    refreshAll();
  }, []);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 3500);
    return () => clearTimeout(t);
  }, [flash]);

  const deleteUpload = async (id: string) => {
    if (!confirm("Delete this upload? All its connections and messages will be removed.")) return;
    try {
      await api.del<{ ok: true }>(`/api/sales/uploads/${id}`);
      setFlash("Upload deleted");
      refreshAll();
    } catch (e) { setFlash(`Delete failed: ${(e as Error).message}`); }
  };

  const unpin = async (id: string) => {
    try {
      await api.del<{ ok: true }>(`/api/sales/pinned/${id}`);
      setPinned((rs) => rs.filter((r) => r.id !== id));
    } catch (e) { setFlash(`Unpin failed: ${(e as Error).message}`); }
  };

  const pinChart = async (spec: ChartSpec, question: string, title: string) => {
    try {
      const r = await api.post<{ id: string }>("/api/sales/pinned", { title, question, spec });
      setPinned((rs) => [
        ...rs,
        {
          id: r.id, title, question, spec,
          position: rs.length, created_at: new Date().toISOString(),
        },
      ]);
      setFlash("Pinned to dashboard");
    } catch (e) { setFlash(`Pin failed: ${(e as Error).message}`); }
  };

  return (
    <div className="stage">
      <div className="wallpaper light-bloom" />
      <div className="sales-analysis">
        <button className="sa-back" onClick={() => navigate("/")} aria-label="Back to overview">
          <IconArrowR size={12} style={{ transform: "rotate(180deg)" }} />
          <span>Back to overview</span>
        </button>

        {flash && <div className="sa-flash">{flash}</div>}

        <div className="sa-content">
          <div className="sa-header">
            <div className="sa-eyebrow">Sales analysis</div>
            <h1 className="sa-title">Pipeline insights</h1>
            <div className="sa-sub">
              Upload a Connections.csv + messages.csv pair for each sales team member.
              Each pair stays grouped to its uploader.
            </div>
          </div>

          <UploadsSection
            uploads={uploads}
            onUploadClick={() => setShowUpload(true)}
            onDelete={deleteUpload}
          />

          {uploads.length > 0 ? (
            <>
              <PinnedSection pinned={pinned} onUnpin={unpin} />
              <ChatSection onPin={pinChart} />
            </>
          ) : (
            <div className="sa-placeholder">
              Upload a team member's data to start analyzing.
            </div>
          )}
        </div>

        {showUpload && (
          <UploadModal
            onClose={() => setShowUpload(false)}
            onUploaded={(team) => {
              setShowUpload(false);
              setFlash(`Imported ${team}'s data`);
              refreshAll();
            }}
          />
        )}
      </div>
    </div>
  );
}

// ---------- uploads section ----------

function UploadsSection({
  uploads, onUploadClick, onDelete,
}: {
  uploads: UploadRow[];
  onUploadClick: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <section className="sa-section">
      <div className="sa-section-head">
        <div className="sa-section-title">Team members</div>
        <button className="pill-btn primary" onClick={onUploadClick}>
          <IconUpload size={12} />Add team member
        </button>
      </div>
      {uploads.length === 0 ? (
        <div className="sa-empty">No uploads yet.</div>
      ) : (
        <div className="sa-uploads">
          {uploads.map((u) => (
            <div key={u.id} className="sa-upload-row">
              <div className="sa-upload-name">{u.team_member_name}</div>
              <div className="sa-upload-meta">
                {u.connections_count.toLocaleString()} connections · {u.messages_count.toLocaleString()} messages
                {u.detected_user_name ? ` · sender: ${u.detected_user_name}` : ""}
              </div>
              <button className="sa-upload-del" onClick={() => onDelete(u.id)} title="Delete">
                <IconClose size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------- pinned analyses ----------

function PinnedSection({ pinned, onUnpin }: { pinned: PinnedRow[]; onUnpin: (id: string) => void }) {
  if (pinned.length === 0) return null;
  return (
    <section className="sa-section">
      <div className="sa-section-head">
        <div className="sa-section-title">Pinned analyses</div>
      </div>
      <div className="sa-charts">
        {pinned.map((p) => (
          <div key={p.id} className="sa-chart-panel">
            <div className="sa-chart-pin-head">
              <div>
                <div className="sa-chart-title">{p.title}</div>
                {p.question && <div className="sa-chart-sub">{p.question}</div>}
              </div>
              <button className="sa-upload-del" onClick={() => onUnpin(p.id)} title="Unpin">
                <IconClose size={12} />
              </button>
            </div>
            <div className="sa-chart-body"><RenderSpec spec={p.spec} /></div>
          </div>
        ))}
      </div>
    </section>
  );
}

function RenderSpec({ spec }: { spec: ChartSpec }) {
  if (spec.kind === "number") {
    const v = spec.data[0]?.value ?? 0;
    return (
      <div className="sa-spec-number">
        <div className="sa-spec-num-value">{typeof v === "number" ? v.toLocaleString() : v}</div>
        <div className="sa-spec-num-metric">{spec.metric}</div>
      </div>
    );
  }
  const data = spec.data.map((d) => ({ name: d.label, value: d.value }));
  if (spec.kind === "pie") {
    return (
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" outerRadius={70}>
            {data.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
          </Pie>
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      </ResponsiveContainer>
    );
  }
  if (spec.kind === "line") {
    return (
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(20,14,40,0.06)" />
          <XAxis dataKey="name" tick={{ fontSize: 10, fill: "var(--text-dim)" }} />
          <YAxis tick={{ fontSize: 11, fill: "var(--text-dim)" }} />
          <Tooltip />
          <Line type="monotone" dataKey="value" stroke="#5e8b7e" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    );
  }
  // bar
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(20,14,40,0.06)" />
        <XAxis dataKey="name" tick={{ fontSize: 10, fill: "var(--text-dim)" }} angle={-15} textAnchor="end" height={50} />
        <YAxis tick={{ fontSize: 11, fill: "var(--text-dim)" }} />
        <Tooltip />
        <Bar dataKey="value" fill="#5e8b7e" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ---------- chat section ----------

function ChatSection({ onPin }: { onPin: (spec: ChartSpec, question: string, title: string) => void }) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [turns]);

  // Auto-grow the composer textarea as the user pastes / types longer briefs.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [input]);

  const send = async () => {
    const q = input.trim();
    if (!q || busy) return;
    setInput("");
    setBusy(true);
    setTurns((t) => [...t, { role: "user", content: q }]);
    try {
      const history = turns.map((t) => ({ role: t.role, content: t.content }));
      const r = await api.post<{
        answer: string;
        charts: ChartSpec[];
        suggestedTitle: string;
      }>("/api/sales/chat", { question: q, history });
      setTurns((t) => [...t, {
        role: "assistant",
        content: r.answer ?? "",
        charts: r.charts ?? [],
        suggestedTitle: r.suggestedTitle ?? "",
      }]);
    } catch (e) {
      setTurns((t) => [...t, { role: "assistant", content: `**Error:** ${(e as Error).message}` }]);
    } finally { setBusy(false); }
  };

  return (
    <div className="sa-chat-shell">
      {turns.length === 0 ? (
        <div className="sa-chat-hero">
          <div className="orb-wrap"><div className={`orb ${busy ? "thinking" : ""}`} /></div>
          <h2>Ask the data.</h2>
          <div className="sa-chat-hero-sub">
            Try <em>"which template variant works best per seniority"</em> or paste a full analysis brief — I have every row in context.
          </div>
        </div>
      ) : (
        <div className="sa-thread">
          {turns.map((t, i) => {
            if (t.role === "user") return <div key={i} className="user-msg">{t.content ?? ""}</div>;
            const text = t.content ?? "";
            return (
              <div key={i} className="ai-block">
                <div className="ai-header"><div className="ai-avatar" /><span>Nontrivial</span></div>
                <div
                  className="ai-summary sa-md"
                  dangerouslySetInnerHTML={{ __html: text ? (marked.parse(text) as string) : "" }}
                />
                {(t.charts ?? []).map((chart, ci) => (
                  <div key={ci} className="sa-inline-chart">
                    <div className="sa-inline-chart-head">
                      <div>
                        <div className="sa-chart-title">{chart.title}</div>
                        {chart.metric && <div className="sa-chart-sub">{chart.metric}</div>}
                      </div>
                      <button
                        className="pill-btn"
                        onClick={() => onPin(chart, turns[i - 1]?.content ?? "", t.suggestedTitle ?? chart.title)}
                      >
                        Pin
                      </button>
                    </div>
                    <div className="sa-chart-body"><RenderSpec spec={chart} /></div>
                  </div>
                ))}
              </div>
            );
          })}
          {busy && (
            <div className="ai-block">
              <div className="ai-header"><div className="ai-avatar" /><span>Nontrivial</span></div>
              <div className="thinking-row">
                <div className="dots"><div className="dot" /><div className="dot" /><div className="dot" /></div>
                <span>Reading your data…</span>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}

      <div className="composer-wrap sa-composer-wrap">
        <div className="composer">
          <div className="composer-row">
            <div className="composer-spark">
              <IconSparkle size={16} style={{ color: "var(--accent)" }} />
            </div>
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              placeholder="Ask about your data, or paste a full brief…"
              rows={1}
            />
          </div>
          <div className="composer-tools">
            <div className="tool-group" />
            <div className="send-group">
              <button className="send" onClick={send} disabled={busy || !input.trim()}>
                <IconSparkle size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- upload modal ----------

function UploadModal({
  onClose, onUploaded,
}: {
  onClose: () => void;
  onUploaded: (teamMember: string) => void;
}) {
  const [teamName, setTeamName] = useState("");
  const [connectionsText, setConnectionsText] = useState("");
  const [messagesText, setMessagesText] = useState("");
  const [userOverride, setUserOverride] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const connRef = useRef<HTMLInputElement>(null);
  const msgRef = useRef<HTMLInputElement>(null);

  const connectionsParsed = useMemo<NetworkImportRow[]>(() => {
    if (!connectionsText.trim()) return [];
    return parseLinkedIn(connectionsText, "connections").slice(0, 50_000);
  }, [connectionsText]);

  const messagesParsed = useMemo<ParsedMessages>(() => {
    if (!messagesText.trim()) return { rows: [], detectedUserName: "", candidateUserNames: [] };
    return parseLinkedInMessages(messagesText, {
      overrideUserName: userOverride || undefined,
      maxContentLength: 1000,
    });
  }, [messagesText, userOverride]);

  const ready = teamName.trim() && (connectionsParsed.length > 0 || messagesParsed.rows.length > 0);

  const handleFile = (kind: "connections" | "messages") => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    if (kind === "connections") setConnectionsText(text);
    else setMessagesText(text);
  };

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.post<{ id: string }>("/api/sales/uploads", {
        teamMemberName: teamName.trim(),
        detectedUserName: messagesParsed.detectedUserName || null,
        connections: connectionsParsed.map((c) => ({
          firstName: c.firstName,
          lastName: c.lastName,
          company: c.company ?? null,
          position: c.position ?? null,
          linkedinUrl: c.linkedinUrl ?? null,
          email: c.email ?? null,
          connectedOn: c.connectedOn ?? null,
        })),
        messages: messagesParsed.rows.map((m: MessageImportRow) => ({
          conversationId: m.conversationId ?? null,
          counterpartName: m.counterpartName,
          counterpartLinkedinUrl: m.counterpartLinkedinUrl ?? null,
          direction: m.direction,
          messageDate: m.messageDate ?? null,
          subject: m.subject ?? null,
          contentSnippet: m.contentSnippet ?? null,
        })),
      });
      onUploaded(teamName.trim());
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <div className="import-modal sa-upload-modal">
        <div className="im-head">
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Add team member</div>
            <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 2 }}>
              Paste or pick the LinkedIn export CSVs for one person.
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}><IconClose size={15} /></button>
        </div>

        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div className="sa-field-label">Team member name</div>
            <input
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              placeholder="e.g. Sarah Chen"
              className="sa-input"
            />
          </div>

          <FilePickRow
            label="Connections.csv"
            count={connectionsParsed.length}
            countLabel="connections"
            inputRef={connRef}
            onFile={handleFile("connections")}
            text={connectionsText}
            onTextChange={setConnectionsText}
          />

          <FilePickRow
            label="messages.csv"
            count={messagesParsed.rows.length}
            countLabel="messages"
            inputRef={msgRef}
            onFile={handleFile("messages")}
            text={messagesText}
            onTextChange={setMessagesText}
          />

          {messagesParsed.candidateUserNames.length > 0 && (
            <div>
              <div className="sa-field-label">Detected sender (the "you" in the messages)</div>
              <select
                value={userOverride || messagesParsed.detectedUserName}
                onChange={(e) => setUserOverride(e.target.value)}
                className="sa-input"
              >
                {messagesParsed.candidateUserNames.map((u) => (
                  <option key={u.name} value={u.name}>{u.name} ({u.count})</option>
                ))}
              </select>
            </div>
          )}

          {err && <div style={{ color: "var(--danger)", fontSize: 12 }}>{err}</div>}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button className="pill-btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="pill-btn primary" onClick={submit} disabled={!ready || busy}>
              {busy ? "Uploading…" : "Upload"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function FilePickRow({
  label, count, countLabel, inputRef, onFile, text, onTextChange,
}: {
  label: string;
  count: number;
  countLabel: string;
  inputRef: React.RefObject<HTMLInputElement>;
  onFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  text: string;
  onTextChange: (s: string) => void;
}) {
  return (
    <div>
      <div className="sa-field-label">
        {label}
        {count > 0 && <span style={{ color: "var(--accent)", marginLeft: 8 }}>{count.toLocaleString()} {countLabel}</span>}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
        <button
          type="button"
          className="pill-btn"
          onClick={() => inputRef.current?.click()}
        >
          <IconUpload size={12} />Pick file
        </button>
        <input
          type="file"
          accept=".csv,text/csv"
          ref={inputRef}
          style={{ display: "none" }}
          onChange={onFile}
        />
        {text && (
          <button type="button" className="pill-btn" onClick={() => onTextChange("")}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
