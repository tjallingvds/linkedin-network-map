import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bar, BarChart, CartesianGrid, Cell, Legend,
  Line, LineChart, Pie, PieChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import { IconArrowR, IconClose, IconUpload, IconSparkle } from "../design/icons";
import { api } from "../lib/api";
import {
  parseLinkedIn,
  parseLinkedInMessages,
  type NetworkImportRow,
  type MessageImportRow,
  type ParsedMessages,
} from "../lib/linkedinCsv";

// ---------- types matching the server ----------

interface UploadRow {
  id: string;
  team_member_name: string;
  detected_user_name: string | null;
  connections_count: number;
  messages_count: number;
  created_at: string;
}

interface Analytics {
  totals: {
    uploads: number; connections: number; messages: number;
    sent: number; received: number;
    cold: number; followUp: number; reply: number;
    uniqueCounterparts: number;
  };
  responseRate: { overall: number; cold: number; followUp: number };
  byTeamMember: {
    uploadId: string; teamMember: string;
    sent: number; received: number; cold: number; followUp: number;
    responseRate: number;
  }[];
  bySeniority: {
    bucket: string; label: string;
    sent: number; replies: number; responseRate: number;
  }[];
  byMessageType: { type: string; count: number }[];
  byMonth: { month: string; sent: number; received: number }[];
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
  chart?: ChartSpec | null;
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

const TYPE_LABEL: Record<string, string> = {
  cold: "Cold outreach",
  follow_up: "Follow-up",
  reply: "Reply",
  received: "Received",
  unknown: "Other",
};

const PIE_COLORS = ["#5e8b7e", "#a7c4bc", "#dfeeea", "#f5b8a3", "#c9a8d4", "#e6c89a"];

// ---------- main page ----------

export function SalesAnalysisPage() {
  const navigate = useNavigate();
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [pinned, setPinned] = useState<PinnedRow[]>([]);
  const [showUpload, setShowUpload] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const refreshAll = async () => {
    try {
      const [u, a, p] = await Promise.all([
        api.get<{ uploads: UploadRow[] }>("/api/sales/uploads"),
        api.get<Analytics>("/api/sales/analytics"),
        api.get<{ pinned: PinnedRow[] }>("/api/sales/pinned"),
      ]);
      setUploads(u.uploads);
      setAnalytics(a);
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

          {analytics && analytics.totals.uploads > 0 ? (
            <>
              <StatGrid analytics={analytics} />
              <ChartsSection analytics={analytics} />
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

// ---------- stat grid ----------

function fmt(n: number): string { return n.toLocaleString(); }
function pct(n: number): string { return `${(n * 100).toFixed(1)}%`; }

function StatGrid({ analytics }: { analytics: Analytics }) {
  const { totals, responseRate } = analytics;
  return (
    <section className="sa-grid">
      <Card label="Messages sent" value={fmt(totals.sent)} hint={`${fmt(totals.received)} received`} />
      <Card label="Unique counterparts" value={fmt(totals.uniqueCounterparts)} hint={`across ${totals.uploads} team member${totals.uploads === 1 ? "" : "s"}`} />
      <Card label="Response rate" value={pct(responseRate.overall)} hint={`cold ${pct(responseRate.cold)} · follow-up ${pct(responseRate.followUp)}`} accent />
      <Card label="Connections imported" value={fmt(totals.connections)} hint={`${fmt(totals.cold)} cold msgs · ${fmt(totals.followUp)} follow-ups`} />
    </section>
  );
}

function Card({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: boolean }) {
  return (
    <div className="sa-card">
      <div className="sa-card-label">{label}</div>
      <div className="sa-card-value" style={accent ? { color: "var(--accent)" } : undefined}>{value}</div>
      {hint && <div className="sa-card-hint">{hint}</div>}
    </div>
  );
}

// ---------- charts ----------

function ChartsSection({ analytics }: { analytics: Analytics }) {
  const teamData = analytics.byTeamMember.map((t) => ({
    name: t.teamMember,
    sent: t.sent,
    responseRate: +(t.responseRate * 100).toFixed(1),
  }));

  const seniorityData = analytics.bySeniority
    .filter((s) => s.sent > 0)
    .map((s) => ({
      name: s.label,
      sent: s.sent,
      responseRate: +(s.responseRate * 100).toFixed(1),
    }));

  const typeData = analytics.byMessageType
    .filter((t) => t.type !== "received" && t.type !== "unknown")
    .map((t) => ({ name: TYPE_LABEL[t.type] ?? t.type, value: t.count }));

  const monthData = analytics.byMonth.map((m) => ({
    month: m.month,
    sent: m.sent,
    received: m.received,
  }));

  return (
    <section className="sa-charts">
      <ChartPanel title="Response rate by team member" subtitle="% of unique counterparts who replied">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={teamData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(20,14,40,0.06)" />
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: "var(--text-dim)" }} />
            <YAxis tick={{ fontSize: 11, fill: "var(--text-dim)" }} unit="%" />
            <Tooltip />
            <Bar dataKey="responseRate" fill="#5e8b7e" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartPanel>

      <ChartPanel title="Response rate by seniority" subtitle="grouped from LinkedIn position strings">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={seniorityData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(20,14,40,0.06)" />
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: "var(--text-dim)" }} angle={-25} textAnchor="end" height={70} />
            <YAxis tick={{ fontSize: 11, fill: "var(--text-dim)" }} unit="%" />
            <Tooltip />
            <Bar dataKey="responseRate" fill="#a7c4bc" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartPanel>

      <ChartPanel title="Message mix" subtitle="cold vs follow-up vs reply">
        <ResponsiveContainer width="100%" height={260}>
          <PieChart>
            <Pie data={typeData} dataKey="value" nameKey="name" outerRadius={80}>
              {typeData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
            </Pie>
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 11 }} />
          </PieChart>
        </ResponsiveContainer>
      </ChartPanel>

      <ChartPanel title="Activity over time" subtitle="messages per month">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={monthData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(20,14,40,0.06)" />
            <XAxis dataKey="month" tick={{ fontSize: 10, fill: "var(--text-dim)" }} />
            <YAxis tick={{ fontSize: 11, fill: "var(--text-dim)" }} />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="sent" stroke="#5e8b7e" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="received" stroke="#c9a8d4" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </ChartPanel>
    </section>
  );
}

function ChartPanel({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="sa-chart-panel">
      <div className="sa-chart-title">{title}</div>
      {subtitle && <div className="sa-chart-sub">{subtitle}</div>}
      <div className="sa-chart-body">{children}</div>
    </div>
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

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [turns]);

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
        chart: ChartSpec | null;
        suggestedTitle: string;
      }>("/api/sales/chat", { question: q, history });
      setTurns((t) => [...t, {
        role: "assistant",
        content: r.answer,
        chart: r.chart,
        suggestedTitle: r.suggestedTitle,
      }]);
    } catch (e) {
      setTurns((t) => [...t, { role: "assistant", content: `Error: ${(e as Error).message}` }]);
    } finally { setBusy(false); }
  };

  return (
    <section className="sa-section">
      <div className="sa-section-head">
        <div className="sa-section-title">Ask the data</div>
      </div>
      <div className="sa-chat">
        <div className="sa-chat-stream">
          {turns.length === 0 && (
            <div className="sa-chat-empty">
              Ask things like <em>"who has the highest reply rate at director level"</em> or{" "}
              <em>"which message type works best for my team?"</em>. If a chart helps, I'll generate one and you can pin it.
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} className={`sa-chat-turn ${t.role}`}>
              <div className="sa-chat-bubble">{t.content}</div>
              {t.chart && t.role === "assistant" && (
                <div className="sa-chat-chart">
                  <div className="sa-chart-title">{t.chart.title}</div>
                  <div className="sa-chart-body"><RenderSpec spec={t.chart} /></div>
                  <button
                    className="pill-btn"
                    style={{ marginTop: 8 }}
                    onClick={() => onPin(t.chart!, turns[i - 1]?.content ?? "", t.suggestedTitle ?? t.chart!.title)}
                  >
                    Pin to dashboard
                  </button>
                </div>
              )}
            </div>
          ))}
          {busy && <div className="sa-chat-turn assistant"><div className="sa-chat-bubble sa-chat-thinking">Thinking…</div></div>}
          <div ref={endRef} />
        </div>
        <div className="sa-chat-input">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            placeholder="Ask about the data… e.g. 'response rate by seniority for Sarah'"
            rows={2}
          />
          <button className="pill-btn primary" onClick={send} disabled={busy || !input.trim()}>
            <IconSparkle size={12} />Ask
          </button>
        </div>
      </div>
    </section>
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
