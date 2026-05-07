import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bar, BarChart, CartesianGrid,
  Line, LineChart, ResponsiveContainer,
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

// ---------- types ----------

interface UploadRow {
  id: string;
  team_member_name: string;
  detected_user_name: string | null;
  connections_count: number;
  messages_count: number;
  created_at: string;
}

interface MessageGroup {
  id: string;
  label: string;
  sampleSnippet: string;
  count: number;
  uniqueRecipients: number;
  senderSplit: { name: string; count: number }[];
  metrics: {
    replyRate: number;
    successRate: number;
    avgFollowupsAfter?: number;
    meanDaysToFirstFollowup?: number | null;
    typicalSentNumber?: number;
    meanDaysSincePrev?: number | null;
  };
  bySeniority: { bucket: string; n: number; successRate: number }[];
  /** Set on synthetic "Other variants" groups so the user can see what
   *  templates were folded in. */
  variantLabels?: string[];
}

interface AuditResult {
  scope: {
    industry: string;
    goal: string;
    totalMatched: number;
    totalCold: number;
    totalFollowUps: number;
  };
  firstMessageGroups: MessageGroup[];
  followUpGroups: MessageGroup[];
  bySeniority: {
    bucket: string;
    label: string;
    bestGroupId: string;
    bestGroupLabel: string;
    successRate: number;
    n: number;
  }[];
  videoImpact: {
    overall: {
      withVideo: { n: number; replyRate: number };
      without: { n: number; replyRate: number };
    };
    byMessageNumber: {
      messageNumber: number;
      n: number;
      withVideo: number;
      replyRateWithVideo: number;
      replyRateOverall: number;
    }[];
    recommendation: string;
  };
  topInsights: string[];
}

// ---------- main page ----------

export function SalesAnalysisPage() {
  const navigate = useNavigate();
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [showUpload, setShowUpload] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const refreshUploads = async () => {
    try {
      const u = await api.get<{ uploads: UploadRow[] }>("/api/sales/uploads");
      setUploads(u.uploads);
    } catch (e) {
      setFlash(`Load failed: ${(e as Error).message}`);
    }
  };

  useEffect(() => {
    refreshUploads();
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
      refreshUploads();
    } catch (e) { setFlash(`Delete failed: ${(e as Error).message}`); }
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

        {uploads.length > 0 ? (
          <div className="sa-fullchat">
            <TeamStrip
              uploads={uploads}
              onAdd={() => setShowUpload(true)}
              onDelete={deleteUpload}
            />
            <AuditView />
          </div>
        ) : (
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
            <div className="sa-placeholder">
              Upload a team member's data to start analyzing.
            </div>
          </div>
        )}

        {showUpload && (
          <UploadModal
            onClose={() => setShowUpload(false)}
            onUploaded={(team) => {
              setShowUpload(false);
              setFlash(`Imported ${team}'s data`);
              refreshUploads();
            }}
          />
        )}
      </div>
    </div>
  );
}

// ---------- slim team strip (chat-dominant layout) ----------

function TeamStrip({
  uploads, onAdd, onDelete,
}: {
  uploads: UploadRow[];
  onAdd: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="sa-topbar">
      <div className="sa-topbar-left">
        <div className="sa-topbar-eyebrow">Sales analysis</div>
        <div className="sa-topbar-chips">
          {uploads.map((u) => (
            <span key={u.id} className="sa-team-chip" title={`${u.connections_count.toLocaleString()} connections · ${u.messages_count.toLocaleString()} messages`}>
              {u.team_member_name}
              <button
                className="sa-team-chip-x"
                onClick={() => onDelete(u.id)}
                aria-label={`Remove ${u.team_member_name}`}
              >
                <IconClose size={10} />
              </button>
            </span>
          ))}
        </div>
      </div>
      <button className="sa-team-add" onClick={onAdd}>
        <IconUpload size={11} />Add team member
      </button>
    </div>
  );
}

// ---------- uploads section (empty-state only) ----------

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

// ---------- audit view (replaces chat) ----------

function fmtPct(n: number | undefined | null): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function AuditView() {
  const [industry, setIndustry] = useState("");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<AuditResult | null>(null);

  const run = async () => {
    if (!industry.trim() || busy) return;
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const r = await api.post<AuditResult>("/api/sales/audit", {
        industry: industry.trim(),
        goal: goal.trim() || null,
      });
      setResult(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  if (busy) {
    return <AuditProgress />;
  }

  if (!result) {
    return (
      <div className="sa-chat-shell">
        <div className="sa-chat-hero">
          <div className="orb-wrap"><div className="orb" /></div>
          <h2>Audit your outreach.</h2>
          <div className="sa-chat-hero-sub">
            Tell me the industry and goal — I'll find the relevant messages, group them granularly, and show what works.
          </div>
        </div>
        <div className="sa-audit-form">
          <div>
            <div className="sa-field-label">Industry / target</div>
            <input
              className="sa-input"
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              placeholder="e.g. Banking, fintech, biotech founders…"
              onKeyDown={(e) => { if (e.key === "Enter" && industry.trim()) run(); }}
            />
          </div>
          <div>
            <div className="sa-field-label">Goal of these messages (optional)</div>
            <input
              className="sa-input"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="e.g. Book a 30-min call about our research"
              onKeyDown={(e) => { if (e.key === "Enter" && industry.trim()) run(); }}
            />
          </div>
          {err && <div style={{ color: "var(--danger)", fontSize: 12 }}>{err}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button className="pill-btn primary" onClick={run} disabled={!industry.trim()}>
              <IconSparkle size={12} />Run audit
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <AuditReport result={result} onReset={() => setResult(null)} />;
}

/** Stage labels that cycle while the LLM runs. There's no real progress
 *  signal coming back from the provider, so this is best-effort: each stage
 *  has a min-duration; we advance to the next once the minimum has elapsed.
 *  The progress bar fills toward an EXPECTED total (90s) but caps at 95%
 *  until the actual response lands so the user never sees a finished bar
 *  on a still-running call. */
const AUDIT_STAGES: { label: string; minSeconds: number }[] = [
  { label: "Filtering messages by industry & goal", minSeconds: 0 },
  { label: "Re-classifying cold vs follow-up per counterpart", minSeconds: 6 },
  { label: "Clustering message templates", minSeconds: 14 },
  { label: "Computing per-group reply / success rates", minSeconds: 28 },
  { label: "Breaking down by seniority", minSeconds: 44 },
  { label: "Analyzing video impact by message-number", minSeconds: 58 },
  { label: "Drafting top insights", minSeconds: 74 },
  { label: "Still working — large datasets take longer", minSeconds: 95 },
];
const EXPECTED_SECONDS = 90;

function AuditProgress() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => {
      setElapsed((Date.now() - start) / 1000);
    }, 250);
    return () => clearInterval(id);
  }, []);

  // Pick the latest stage whose minSeconds is ≤ elapsed.
  let stageIdx = 0;
  for (let i = 0; i < AUDIT_STAGES.length; i++) {
    const s = AUDIT_STAGES[i];
    if (s && elapsed >= s.minSeconds) stageIdx = i;
  }
  const stage = AUDIT_STAGES[stageIdx] ?? AUDIT_STAGES[0]!;
  const pct = Math.min(95, (elapsed / EXPECTED_SECONDS) * 100);
  const elapsedLabel =
    elapsed < 60
      ? `${Math.floor(elapsed)}s elapsed`
      : `${Math.floor(elapsed / 60)}m ${Math.floor(elapsed % 60)}s elapsed`;

  return (
    <div className="sa-chat-shell">
      <div className="sa-chat-hero">
        <div className="orb-wrap"><div className="orb thinking" /></div>
        <h2>Auditing your outreach.</h2>
        <div className="sa-chat-hero-sub">
          {stage.label}…
        </div>
      </div>
      <div className="sa-progress-wrap">
        <div className="sa-progress-bar">
          <div className="sa-progress-fill" style={{ width: `${pct}%` }} />
          <div className="sa-progress-shimmer" />
        </div>
        <div className="sa-progress-meta">
          <span>{stageIdx + 1} of {AUDIT_STAGES.length}</span>
          <span>{elapsedLabel}</span>
        </div>
        <ol className="sa-progress-steps">
          {AUDIT_STAGES.slice(0, -1).map((s, i) => (
            <li
              key={s.label}
              className={
                i < stageIdx ? "done" :
                i === stageIdx ? "active" :
                "pending"
              }
            >
              {s.label}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function AuditReport({ result, onReset }: { result: AuditResult; onReset: () => void }) {
  return (
    <div className="sa-audit-report">
      <div className="sa-report-head">
        <div>
          <div className="sa-eyebrow" style={{ marginBottom: 4 }}>
            Audit · {result.scope.industry}{result.scope.goal ? ` · ${result.scope.goal}` : ""}
          </div>
          <h2 className="sa-report-title">
            {result.scope.totalCold} first messages · {result.scope.totalFollowUps} follow-ups · {result.scope.totalMatched} total matched
          </h2>
        </div>
        <button className="pill-btn" onClick={onReset}>New audit</button>
      </div>

      {result.topInsights?.length > 0 && (
        <div className="sa-insights">
          {result.topInsights.map((ins, i) => (
            <div key={i} className="sa-insight">{ins}</div>
          ))}
        </div>
      )}

      <div className="sa-section-title">First-message templates</div>
      <div className="sa-group-grid">
        {result.firstMessageGroups.map((g) => <GroupCard key={g.id} group={g} kind="cold" />)}
      </div>

      {result.followUpGroups?.length > 0 && (
        <>
          <div className="sa-section-title">Follow-up templates</div>
          <div className="sa-group-grid">
            {result.followUpGroups.map((g) => <GroupCard key={g.id} group={g} kind="follow_up" />)}
          </div>
        </>
      )}

      <>
        <div className="sa-section-title">Best approach per seniority</div>
        {result.bySeniority?.length > 0 ? (
          <div className="sa-table-wrap">
            <table className="sa-md-table">
              <thead>
                <tr><th>Seniority</th><th>Best template</th><th>Success</th><th>n</th></tr>
              </thead>
              <tbody>
                {result.bySeniority.map((s) => (
                  <tr key={s.bucket}>
                    <td>{s.label}</td>
                    <td>{s.bestGroupLabel}</td>
                    <td>{fmtPct(s.successRate)}</td>
                    <td>{s.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="sa-empty">
            Not enough data per seniority bucket after filtering. Try a broader industry / goal.
          </div>
        )}
      </>

      {result.videoImpact && (
        <>
          <div className="sa-section-title">Video impact</div>
          <div className="sa-video-impact">
            <div className="sa-video-summary">
              <div className="sa-video-cell">
                <div className="sa-video-label">With video</div>
                <div className="sa-video-value">{fmtPct(result.videoImpact.overall.withVideo.replyRate)}</div>
                <div className="sa-video-n">n = {result.videoImpact.overall.withVideo.n}</div>
              </div>
              <div className="sa-video-cell">
                <div className="sa-video-label">Without video</div>
                <div className="sa-video-value">{fmtPct(result.videoImpact.overall.without.replyRate)}</div>
                <div className="sa-video-n">n = {result.videoImpact.overall.without.n}</div>
              </div>
            </div>
            {result.videoImpact.byMessageNumber.length > 0 && (
              <div className="sa-video-chart">
                <div className="sa-chart-sub">Reply rate by sent-message-number — bars show with-video, line shows overall.</div>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={result.videoImpact.byMessageNumber.map((b) => ({
                    name: `#${b.messageNumber} (n=${b.n})`,
                    withVideo: +(b.replyRateWithVideo * 100).toFixed(1),
                    overall: +(b.replyRateOverall * 100).toFixed(1),
                  }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(20,14,40,0.06)" />
                    <XAxis dataKey="name" tick={{ fontSize: 11, fill: "var(--text-dim)" }} />
                    <YAxis tick={{ fontSize: 11, fill: "var(--text-dim)" }} unit="%" />
                    <Tooltip />
                    <Bar dataKey="withVideo" fill="#5e8b7e" radius={[4, 4, 0, 0]} />
                    <Line type="monotone" dataKey="overall" stroke="#c9a8d4" strokeWidth={2} dot={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            {result.videoImpact.recommendation && (
              <div className="sa-video-rec">{result.videoImpact.recommendation}</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function GroupCard({ group, kind }: { group: MessageGroup; kind: "cold" | "follow_up" }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sa-group-card">
      <div className="sa-group-head">
        <div className="sa-group-label">{group.label}</div>
        <button className="sa-group-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide message" : "Read message"}
        </button>
      </div>
      <div className="sa-group-metrics">
        <Metric label="Sent" value={String(group.count)} />
        <Metric label="Unique recipients" value={String(group.uniqueRecipients)} />
        <Metric label="Reply rate" value={fmtPct(group.metrics.replyRate)} />
        <Metric label="Success" value={fmtPct(group.metrics.successRate)} accent />
        {kind === "cold" ? (
          <>
            <Metric label="Avg follow-ups after" value={group.metrics.avgFollowupsAfter?.toFixed(1) ?? "—"} />
            <Metric label="Mean days → first follow-up" value={group.metrics.meanDaysToFirstFollowup != null ? group.metrics.meanDaysToFirstFollowup.toFixed(1) + "d" : "—"} />
          </>
        ) : (
          <>
            <Metric label="Typical position" value={group.metrics.typicalSentNumber ? `#${group.metrics.typicalSentNumber}` : "—"} />
            <Metric label="Mean days since prev" value={group.metrics.meanDaysSincePrev != null ? group.metrics.meanDaysSincePrev.toFixed(1) + "d" : "—"} />
          </>
        )}
      </div>
      {group.senderSplit?.length > 0 && (
        <div className="sa-group-senders">
          {group.senderSplit.map((s) => (
            <span key={s.name} className="sa-sender-chip">{s.name}: {s.count}</span>
          ))}
        </div>
      )}
      {open && (
        <div className="sa-group-sample">
          <div className="sa-field-label">Sample message</div>
          <div className="sa-sample-text">{group.sampleSnippet}</div>
          {group.variantLabels && group.variantLabels.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="sa-field-label">Folded variants</div>
              <div className="sa-group-senders">
                {group.variantLabels.map((v, i) => (
                  <span key={i} className="sa-sender-chip">{v}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {group.bySeniority?.length > 0 && (
        <div className="sa-group-seniority">
          <div className="sa-field-label" style={{ marginBottom: 4 }}>Per seniority</div>
          {group.bySeniority.map((s) => (
            <div key={s.bucket} className="sa-seniority-row">
              <span>{s.bucket}</span>
              <span className="sa-seniority-n">n={s.n}</span>
              <span className="sa-seniority-rate">{fmtPct(s.successRate)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="sa-metric">
      <div className="sa-metric-label">{label}</div>
      <div className="sa-metric-value" style={accent ? { color: "var(--accent)" } : undefined}>{value}</div>
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
          hasVideo: m.hasVideo ?? false,
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
