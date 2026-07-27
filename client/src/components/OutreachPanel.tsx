/**
 * Automations — email sending for one CRM board, in plain language.
 *
 * Deliberately avoids the internal vocabulary (tier / gate / funnel /
 * suppression / reconcile). On screen it reads as: groups, send, who won't be
 * emailed, results, never email. The API still speaks the old names; the
 * translation is contained here.
 *
 * The single most important thing this page must communicate: the emails
 * themselves are written in Smartlead. This page only decides WHO receives
 * them, and stops sending when someone replies.
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { IconClose } from "../design/icons";

type Group = "A" | "B" | "C";
const GROUPS: Group[] = ["A", "B", "C"];

interface Campaign { id: string; board_id: string; provider_campaign_id: string; tier: Group; name: string | null; state: string }
interface BoardStatus {
  boardId: string; name: string; connected: boolean; enabled: boolean;
  webhookUrl: string | null; bounceThresholdPct: number;
  stopStages: string[]; campaigns: Campaign[];
  openingPrompt: string; defaultPrompt: string;
  suppressionCount: number; unreadAlerts: number;
}
interface Readiness {
  connected: boolean; enabled: boolean; total: number; withEmail: number;
  byGroup: Record<Group, number>; ready: Record<Group, number>; mappedGroups: Group[];
}
interface ConnectResp { webhookUrl: string; webhookSecret: string; subscribeTo: string[] }
interface RemoteCampaign { id: number; name: string; status: string }
interface AlertRow { id: string; severity: string; message: string; created_at: string }
interface Excluded { id: string; name: string; email: string | null; stage: string; reason: string; fixable: boolean }
interface ResultRow {
  tier: string | null; sent: number; delivered: number; replied: number;
  bounced: number; unsubscribed: number;
  bounceRate: number; replyRate: number; unsubRate: number;
}
export interface StageOption { id: string; label: string }

/** One block of the page: a title row over a hairline, then a bordered body. */
function Sec({ title, hint, chip, chipTone, muted, children }: {
  title: string; hint?: React.ReactNode; chip?: string;
  chipTone?: "on" | "bad"; muted?: boolean; children: React.ReactNode;
}) {
  return (
    <section className={`au-sec${muted ? " is-muted" : ""}`}>
      <div className="au-sec-head">
        <h3 className="au-sec-title">{title}</h3>
        {chip && <span className={`au-chip${chipTone === "on" ? " is-on" : chipTone === "bad" ? " is-bad" : ""}`}>{chip}</span>}
        {hint && <span className="au-sec-hint">{hint}</span>}
      </div>
      <div className="au-sec-body">{children}</div>
    </section>
  );
}

export function OutreachPanel({
  boardId, boardName, stages, onFlash,
}: { boardId: string; boardName: string; stages: StageOption[]; onFlash: (m: string) => void }) {
  const [st, setSt] = useState<BoardStatus | null>(null);
  const [ready, setReady] = useState<Readiness | null>(null);
  const [results, setResults] = useState<ResultRow[] | null>(null);
  const [excluded, setExcluded] = useState<Excluded[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [setup, setSetup] = useState<ConnectResp | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [skipOpen, setSkipOpen] = useState(false);

  const load = async () => {
    try {
      const s = await api.get<BoardStatus>(`/api/outreach/board/${boardId}`);
      setSt(s);
      setReady(await api.get<Readiness>(`/api/outreach/board/${boardId}/readiness`));
      if (s.connected) {
        setResults((await api.get<{ rows: ResultRow[] }>(`/api/outreach/board/${boardId}/metrics`)).rows);
        setExcluded((await api.get<{ excluded: Excluded[] }>(`/api/outreach/board/${boardId}/excluded`)).excluded);
      }
    } catch (e) {
      onFlash(`Email: ${(e as Error).message}`);
    } finally { setLoading(false); }
  };
  useEffect(() => { setLoading(true); void load(); }, [boardId]);

  const connect = async () => {
    const key = apiKey.trim();
    if (!key) return;
    setConnecting(true);
    try {
      const r = await api.post<ConnectResp>(`/api/outreach/board/${boardId}/connect`, { apiKey: key });
      setSetup(r); setShowAdvanced(true); setApiKey("");
      onFlash("Connected. Nothing sends until you turn sending on.");
      await load();
    } catch (e) { onFlash(`Connect failed: ${(e as Error).message}`); }
    finally { setConnecting(false); }
  };

  const toggle = async (enabled: boolean) => {
    try {
      await api.post(`/api/outreach/board/${boardId}/enabled`, { enabled });
      onFlash(enabled ? `Sending is ON for ${boardName}.` : `Sending is OFF for ${boardName}.`);
      await load();
    } catch (e) { onFlash(`Failed: ${(e as Error).message}`); }
  };

  const copy = (label: string, v: string) =>
    void navigator.clipboard?.writeText(v).then(() => onFlash(`${label} copied`));

  if (loading) return <div className="au-wrap"><div className="au-empty">Loading…</div></div>;

  const connected = !!st?.connected;
  const on = !!st?.enabled;

  // One total across every group — the campaign-level numbers.
  const t = (results ?? []).reduce(
    (a, r) => ({
      sent: a.sent + r.sent, delivered: a.delivered + r.delivered,
      bounced: a.bounced + r.bounced, replied: a.replied + r.replied,
      unsub: a.unsub + r.unsubscribed,
    }),
    { sent: 0, delivered: 0, bounced: 0, replied: 0, unsub: 0 },
  );
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
  const bounceRate = pct(t.bounced, t.sent);
  const replyRate = pct(t.replied, t.delivered);
  const threshold = st?.bounceThresholdPct ?? 2;
  const overBounce = t.sent >= 20 && bounceRate >= threshold;

  if (!connected) {
    return (
      <div className="au-wrap">
        <Hero on={false} connected={false} boardName={boardName} />
        <Sec title="Connect this board to Smartlead"
          hint="Stored encrypted, and used only for this board.">
          <div className="au-field">
            <span className="au-field-label">API key</span>
            <input type="password" className="au-input" value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void connect(); }}
              placeholder="Paste your Smartlead API key" />
            <button className="pill-btn primary" onClick={connect} disabled={!apiKey.trim() || connecting}>
              {connecting ? "Connecting…" : "Connect"}
            </button>
          </div>
        </Sec>
      </div>
    );
  }

  return (
    <div className="au-wrap">
      <Hero on={on} connected boardName={boardName} onToggle={() => toggle(!on)}
        waiting={GROUPS.reduce((n, g) => n + (ready?.ready[g] ?? 0), 0)}
        people={ready?.total ?? 0} sent={t.sent} />

      {/* The two numbers that matter, side by side. */}
      <div className="au-two">
        <div className="au-metric">
          <div className="au-metric-head">
            <h3 className="au-sec-title">Results</h3>
            <span className="au-sec-hint">Since this campaign started.</span>
          </div>
          {t.sent === 0 ? <div className="au-empty">Nothing sent yet.</div> : (
            <>
              <div className="au-big">
                <div><div className="au-big-v">{t.sent}</div><div className="au-big-k">emailed</div></div>
                <div><div className="au-big-v">{t.replied}</div><div className="au-big-k">replied</div></div>
                <div><div className="au-big-v">{replyRate}%</div><div className="au-big-k">reply rate</div></div>
              </div>
              <div className="au-bars">
                <Bar label="Delivered" n={t.delivered} of={t.sent} />
                <Bar label="Bounced" n={t.bounced} of={t.sent} bad={overBounce} />
                <Bar label="Unsubscribed" n={t.unsub} of={t.sent} />
              </div>
            </>
          )}
        </div>

        <div className={`au-metric${overBounce ? " is-bad" : ""}`}>
          <div className="au-metric-head">
            <h3 className="au-sec-title">Warnings</h3>
            <span className="au-sec-hint">Above {threshold}% bounce hurts your domain.</span>
          </div>
          <Warnings boardId={boardId} threshold={threshold} bounceRate={bounceRate}
            sent={t.sent} overBounce={overBounce} onFlash={onFlash} onChanged={load} />
        </div>
      </div>

      {/* Groups — the core setup. */}
      <Groups boardId={boardId} campaigns={st!.campaigns} readiness={ready}
        disabled={!on} onChanged={load} onFlash={onFlash} />

      {/* How the opening line gets written. */}
      <PromptEditor boardId={boardId} value={st!.openingPrompt} fallback={st!.defaultPrompt}
        onFlash={onFlash} onChanged={load} />

      {/* Excluded + stop rules live behind one popup. */}
      <div className="au-inline-row">
        <button className="pill-btn" onClick={() => setSkipOpen(true)}>
          {excluded?.length ?? 0} contacts excluded
        </button>
        <span className="au-note">Who won’t be emailed, and the stages that stop sending.</span>
        <button className="pill-btn" style={{ marginLeft: "auto" }} onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? "Hide setup" : "Webhook & setup"}
        </button>
      </div>

      {showAdvanced && (
        <Sec title="Webhook & setup" hint="Paste into Smartlead → Settings → Webhooks.">
          <Row label="URL" value={setup?.webhookUrl ?? st!.webhookUrl ?? ""} onCopy={copy} />
          {setup?.webhookSecret
            ? <Row label="Secret" value={setup.webhookSecret} onCopy={copy} secret />
            : <div className="au-note">The secret is shown once — when you connect, or make a new one.</div>}
          <div className="au-note">
            Events: <code>EMAIL_SENT, EMAIL_REPLY, EMAIL_BOUNCE, LEAD_UNSUBSCRIBED, LEAD_CATEGORY_UPDATED</code>
          </div>
          <div className="au-actions">
            <button className="pill-btn" onClick={async () => {
              try {
                setSetup(await api.post<ConnectResp>(`/api/outreach/board/${boardId}/rotate-webhook`));
                onFlash("New secret — update Smartlead now, the old URL is dead.");
                await load();
              } catch (e) { onFlash(`Failed: ${(e as Error).message}`); }
            }}>New secret</button>
            <button className="pill-btn" onClick={async () => {
              try {
                const c = await api.post<{ checked: number; releaks: number; repliesRecovered: number }>(`/api/outreach/board/${boardId}/reconcile`);
                onFlash(`Checked ${c.checked} · stopped ${c.releaks} · found ${c.repliesRecovered} missed replies`);
                await load();
              } catch (e) { onFlash(`Failed: ${(e as Error).message}`); }
            }}>Re-check with Smartlead</button>
            <button className="pill-btn" onClick={async () => {
              try {
                await api.post(`/api/outreach/board/${boardId}/disconnect`);
                onFlash("Disconnected. Sending is off for this board.");
                setSetup(null); await load();
              } catch (e) { onFlash(`Failed: ${(e as Error).message}`); }
            }}>Disconnect</button>
          </div>
        </Sec>
      )}

      <details className="au-how">
        <summary>How does this actually send an email?</summary>
        <ol className="au-steps">
          <li><b>You write the emails in Smartlead.</b> A campaign there is one sequence — subject, wording, follow-ups. None of that text lives here.</li>
          <li><b>Here you choose who gets them.</b> Put a contact in group A, B or C, then point that group at a Smartlead campaign above.</li>
          <li><b>Everyone goes through approval.</b> Each person gets their own first line and queues under <b>Need approval</b> in the sidebar. Nothing is ever sent from this page.</li>
          <li><b>Replies stop the emails automatically.</b> If someone answers — or you drag their card to a stop stage — their sequence pauses.</li>
        </ol>
      </details>

      {skipOpen && (
        <SkipModal boardId={boardId} excluded={excluded} stages={stages} stopStages={st!.stopStages}
          onClose={() => setSkipOpen(false)} onChanged={load} onFlash={onFlash} />
      )}
    </div>
  );
}

/** Status banner. */
function Hero({ on, connected, boardName, onToggle, waiting, people, sent }: {
  on: boolean; connected: boolean; boardName: string;
  onToggle?: () => void; waiting?: number; people?: number; sent?: number;
}) {
  return (
    <div className={`au-hero${on ? " is-on" : ""}`}>
      <div className="au-hero-main">
        <div className="au-hero-row">
          <span className={`au-pill${on ? " is-on" : ""}`}>
            <span className="au-dot" />{!connected ? "Not connected" : on ? "Sending on" : "Sending off"}
          </span>
          <h2 className="au-hero-title">{boardName}</h2>
        </div>
        <div className="au-hero-sub">
          {!connected
            ? "Connect this board to Smartlead. Every board has its own account and its own emails."
            : on
              ? "People in a group are drafted and queued under Need approval. Nothing sends until you approve it."
              : "Nothing will be emailed from this board. Turning this on does not send anything by itself."}
        </div>
        {connected && (
          <div className="au-stats">
            <div><div className="au-stat-k">In this board</div><div className="au-stat-v">{people ?? 0}</div></div>
            <div><div className="au-stat-k">Awaiting approval</div><div className="au-stat-v">{waiting ?? 0}</div></div>
            <div><div className="au-stat-k">Emailed</div><div className="au-stat-v">{sent ?? 0}</div></div>
          </div>
        )}
      </div>
      {connected && onToggle && (
        <button className={`pill-btn${on ? "" : " primary"}`} onClick={onToggle}>
          {on ? "Turn off" : "Turn on"}
        </button>
      )}
    </div>
  );
}

function Bar({ label, n, of, bad }: { label: string; n: number; of: number; bad?: boolean }) {
  const p = of > 0 ? Math.round((n / of) * 1000) / 10 : 0;
  return (
    <div className="au-bar">
      <div className="au-bar-top">
        <span>{label}</span>
        <span className={`au-bar-n${bad ? " is-bad" : ""}`}>{n} · {p}%</span>
      </div>
      <div className="au-bar-track">
        <div className={`au-bar-fill${bad ? " is-bad" : ""}`} style={{ width: `${Math.min(100, p)}%` }} />
      </div>
    </div>
  );
}

function Row({ label, value, onCopy, secret }: {
  label: string; value: string; onCopy: (l: string, v: string) => void; secret?: boolean;
}) {
  return (
    <div className="au-field">
      <span className="au-field-label">{label}</span>
      <code className="au-code">{secret ? value.replace(/.(?=.{4})/g, "•") : value}</code>
      <button type="button" className="pill-btn" onClick={() => onCopy(label, value)}>Copy</button>
    </div>
  );
}

/** Bounce warning + anything the nightly check raised. */
function Warnings({ boardId, threshold, bounceRate, sent, overBounce, onFlash, onChanged }: {
  boardId: string; threshold: number; bounceRate: number; sent: number;
  overBounce: boolean; onFlash: (m: string) => void; onChanged: () => void;
}) {
  const [alerts, setAlerts] = useState<AlertRow[] | null>(null);
  const [pct, setPct] = useState(threshold);
  useEffect(() => { setPct(threshold); }, [threshold]);

  const load = async () => {
    try { setAlerts((await api.get<{ alerts: AlertRow[] }>(`/api/outreach/board/${boardId}/alerts`)).alerts); }
    catch (e) { onFlash(`Failed: ${(e as Error).message}`); }
  };
  useEffect(() => { void load(); }, [boardId]);

  const dismiss = async (id?: string) => {
    try { await api.post("/api/outreach/alerts/read", id ? { id } : {}); await load(); onChanged(); }
    catch (e) { onFlash(`Failed: ${(e as Error).message}`); }
  };

  return (
    <>
      {overBounce && (
        <div className="au-alert is-critical">
          <span>⛔</span>
          <div className="au-alert-msg">
            <b>{bounceRate}% of your emails bounced.</b> That’s above {threshold}% — stop sending and clean
            the list before this costs you the domain’s reputation.
          </div>
        </div>
      )}
      {alerts?.map((a) => (
        <div key={a.id} className={`au-alert${a.severity === "critical" ? " is-critical" : ""}`}>
          <span>{a.severity === "critical" ? "⛔" : "⚠️"}</span>
          <div className="au-alert-msg">
            {a.message}
            <div className="au-alert-time">{new Date(a.created_at).toLocaleString()}</div>
          </div>
          <button className="pill-btn" onClick={() => dismiss(a.id)}>OK</button>
        </div>
      ))}
      {!overBounce && !alerts?.length && (
        <div className="au-ok">
          <span>✓</span>
          <div>
            {sent === 0
              ? "Nothing to watch yet — warnings appear once you start sending."
              : `Nothing wrong. Bounce rate is ${bounceRate}%.`}
          </div>
        </div>
      )}
      <div className="au-field" style={{ marginTop: "auto" }}>
        <span className="au-field-label">Warn above</span>
        <input type="number" min={1} max={50} className="au-input is-tiny" value={pct}
          onChange={(e) => setPct(Number(e.target.value))} />
        <span className="au-note">% bounced</span>
        <button className="pill-btn" disabled={pct === threshold} onClick={async () => {
          try {
            await api.post(`/api/outreach/board/${boardId}/threshold`, { bounceThresholdPct: pct });
            onFlash("Saved."); onChanged();
          } catch (e) { onFlash(`Failed: ${(e as Error).message}`); }
        }}>Save</button>
      </div>
    </>
  );
}

/** Groups → Smartlead campaigns. The core setup. */
function Groups({ boardId, campaigns, readiness, disabled, onChanged, onFlash }: {
  boardId: string; campaigns: Campaign[]; readiness: Readiness | null;
  disabled?: boolean; onChanged: () => void; onFlash: (m: string) => void;
}) {
  const [remote, setRemote] = useState<RemoteCampaign[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try { setRemote((await api.get<{ campaigns: RemoteCampaign[] }>(`/api/outreach/board/${boardId}/campaigns/remote`)).campaigns); }
      catch (e) { onFlash(`Couldn’t load campaigns: ${(e as Error).message}`); }
      finally { setLoading(false); }
    })();
  }, [boardId]);

  const setCampaign = async (group: Group, providerCampaignId: string, name?: string) => {
    try {
      await api.post(`/api/outreach/board/${boardId}/campaigns`, { group, providerCampaignId, name });
      onFlash(`Group ${group} will use that campaign.`);
      onChanged();
    } catch (e) { onFlash(`Failed: ${(e as Error).message}`); }
  };

  return (
    <Sec title="Groups"
      hint="A group is a label on your contacts. Each one sends through its own Smartlead campaign.">
      {GROUPS.map((g) => {
        const mapped = campaigns.find((c) => c.tier === g);
        const people = readiness?.byGroup[g] ?? 0;
        return (
          <div key={g} className="au-group">
            <span className="au-group-tag">{g}</span>
            <select className="au-input" disabled={disabled || loading}
              value={mapped?.provider_campaign_id ?? ""}
              onChange={(e) => {
                const id = e.target.value;
                if (!id) return;
                setCampaign(g, id, remote?.find((r) => String(r.id) === id)?.name);
              }}>
              <option value="">{loading ? "Loading campaigns…" : "— pick a Smartlead campaign —"}</option>
              {remote?.map((r) => <option key={r.id} value={String(r.id)}>{r.name}</option>)}
              {mapped && !remote?.some((r) => String(r.id) === mapped.provider_campaign_id) && (
                <option value={mapped.provider_campaign_id}>Campaign #{mapped.provider_campaign_id}</option>
              )}
            </select>
            <span className="au-count">{people} {people === 1 ? "person" : "people"}</span>
          </div>
        );
      })}
      <div className="au-note">
        Put someone in a group by setting the <b>Group</b> field on their contact to A, B or C.
      </div>
    </Sec>
  );
}

/** The instructions used to write every opening line. */
function PromptEditor({ boardId, value, fallback, onFlash, onChanged }: {
  boardId: string; value: string; fallback: string;
  onFlash: (m: string) => void; onChanged: () => void;
}) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  useEffect(() => { setText(value); }, [boardId, value]);
  const dirty = text.trim() !== value.trim();

  return (
    <Sec title="How opening lines are written"
      chip={value.trim() ? "custom" : "default"}
      hint="The instructions given to the model for every person on this board.">
      <div className="au-note">
        Each person’s first line is written from their LinkedIn and your CRM notes, and is told to lead into
        the campaign’s own email. Leave this blank to use the built-in instructions.
      </div>
      {!open && !value.trim() ? (
        <div className="au-actions">
          <button className="pill-btn" onClick={() => setOpen(true)}>Customise the instructions</button>
        </div>
      ) : (
        <>
          <textarea className="au-prompt" rows={8} value={text} placeholder={fallback}
            onChange={(e) => setText(e.target.value)} />
          <div className="au-actions">
            <button className="pill-btn primary" disabled={!dirty} onClick={async () => {
              try {
                await api.post(`/api/outreach/board/${boardId}/prompt`, { prompt: text });
                onFlash(text.trim() ? "Instructions saved." : "Back to the built-in instructions.");
                onChanged();
              } catch (e) { onFlash(`Failed: ${(e as Error).message}`); }
            }}>Save</button>
            {value.trim() && (
              <button className="pill-btn" onClick={() => setText("")}>Reset to default</button>
            )}
            {dirty && <span className="au-note">Unsaved</span>}
          </div>
          <div className="au-note">
            “Never invent anything” and the output format are always enforced, whatever you write here.
          </div>
        </>
      )}
    </Sec>
  );
}

/** Excluded contacts + the stages that stop sending, in one popup. */
function SkipModal({ boardId, excluded, stages, stopStages, onClose, onChanged, onFlash }: {
  boardId: string; excluded: Excluded[] | null; stages: StageOption[]; stopStages: string[];
  onClose: () => void; onChanged: () => void; onFlash: (m: string) => void;
}) {
  const byReason = new Map<string, Excluded[]>();
  for (const r of excluded ?? []) {
    if (!byReason.has(r.reason)) byReason.set(r.reason, []);
    byReason.get(r.reason)!.push(r);
  }
  const groups = [...byReason.entries()].sort((a, b) => b[1].length - a[1].length);

  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <div className="app-modal au-modal">
        <div className="app-modal-head">
          <span className="app-modal-title">Excluded contacts</span>
          <button className="icon-btn" onClick={onClose}><IconClose size={16} /></button>
        </div>
        <div className="app-modal-body au-modal-body">
          <StopStages boardId={boardId} stages={stages} current={stopStages}
            onChanged={onChanged} onFlash={onFlash} />

          <div className="au-modal-sec">
            <h4 className="au-sec-title">Not being emailed</h4>
            <span className="au-sec-hint">{excluded?.length ?? 0} people, and why.</span>
          </div>
          {!excluded ? <div className="au-empty">Loading…</div>
            : excluded.length === 0 ? <div className="au-empty">Everyone here can be emailed.</div>
            : groups.map(([reason, list]) => (
              <div key={reason} className="au-skip">
                <div className="au-skip-head">
                  <span className="au-reason-n">{list.length}</span>
                  <span className="au-reason-t">{reason}</span>
                  {list[0]?.fixable && <span className="au-chip">you can fix this</span>}
                </div>
                <div className="au-table-wrap">
                  <table className="au-table">
                    <tbody>
                      {list.slice(0, 60).map((r) => (
                        <tr key={r.id}>
                          <td className="au-t-name">{r.name}</td>
                          <td>{r.email ?? "—"}</td>
                          <td className="au-src">{r.stage}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {list.length > 60 && <div className="au-note">+{list.length - 60} more</div>}
                </div>
              </div>
            ))}
        </div>
        <div className="app-modal-foot au-modal-foot">
          <NeverEmail onFlash={onFlash} onDone={onChanged} />
          <button className="pill-btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </>
  );
}

/**
 * Tick the stages that mean "stop emailing these people".
 *
 * Saves BOTH the stage id and its current label. A contact's `stage` column
 * holds the id, but imported rows can hold the label — and renaming a stage
 * changes the label while keeping the id. Storing both means the rule keeps
 * working through a rename, which is otherwise a silent failure.
 */
function StopStages({ boardId, stages, current, onChanged, onFlash }: {
  boardId: string; stages: StageOption[]; current: string[];
  onChanged: () => void; onFlash: (m: string) => void;
}) {
  const key = current.slice().sort().join("|");
  const idsFrom = (saved: string[]) =>
    stages.filter((s) => saved.includes(s.id) || saved.includes(s.label)).map((s) => s.id);
  const [picked, setPicked] = useState<string[]>(() => idsFrom(current));
  useEffect(() => { setPicked(idsFrom(current)); }, [boardId, key, stages.length]);

  const orphans = current.filter((v) => !stages.some((s) => s.id === v || s.label === v));
  const [keptOrphans, setKeptOrphans] = useState<string[]>(orphans);
  useEffect(() => { setKeptOrphans(orphans); }, [key, stages.length]);

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const toSave = [...new Set([
    ...picked.flatMap((id) => {
      const s = stages.find((x) => x.id === id);
      return s ? [s.id, s.label] : [id];
    }),
    ...keptOrphans,
  ])];
  // Compare the SELECTION, not the payload: what we save (id + label) is wider
  // than what may already be stored, so comparing payloads would always differ.
  const dirty = [...picked, ...keptOrphans].sort().join("|") !== [...idsFrom(current), ...orphans].sort().join("|");

  return (
    <>
      <div className="au-modal-sec">
        <h4 className="au-sec-title">Stop sending when a card moves to…</h4>
        <span className="au-sec-hint">Renaming a stage is safe — the rule follows it.</span>
      </div>
      <div className="au-checks">
        {stages.map((s) => (
          <label key={s.id} className={`au-check${picked.includes(s.id) ? " is-on" : ""}`}>
            <input type="checkbox" checked={picked.includes(s.id)} onChange={() => toggle(s.id)} />
            {s.label}
          </label>
        ))}
        {keptOrphans.map((v) => (
          <label key={`gone-${v}`} className="au-check is-on">
            <input type="checkbox" checked
              onChange={() => setKeptOrphans((k) => k.filter((x) => x !== v))} />
            {v} <span className="au-gone">(removed stage)</span>
          </label>
        ))}
      </div>
      <div className="au-actions">
        <button className="pill-btn primary" disabled={!dirty} onClick={async () => {
          try {
            await api.post(`/api/outreach/board/${boardId}/stop-stages`, { stages: toSave });
            onFlash("Saved."); onChanged();
          } catch (e) { onFlash(`Failed: ${(e as Error).message}`); }
        }}>Save</button>
        {dirty && <span className="au-note">Unsaved</span>}
      </div>
    </>
  );
}

/**
 * Never email someone, by hand.
 *
 * Unsubscribes, hard bounces and replies categorised as "do not contact" are
 * suppressed automatically — this is only for a request that arrives off-channel
 * (a phone call, someone forwarding a complaint), which nothing else can catch.
 */
function NeverEmail({ onFlash, onDone }: { onFlash: (m: string) => void; onDone: () => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="au-never">
      <span className="au-note">Never email</span>
      <input className="au-input" value={value} onChange={(e) => setValue(e.target.value)}
        placeholder="person@acme.com or acme.com" />
      <button className="pill-btn" disabled={!value.trim()} onClick={async () => {
        const v = value.trim();
        const body = v.includes("@") ? { email: v } : { domain: v };
        try {
          await api.post("/api/outreach/suppress", { ...body, reason: "manual" });
          onFlash(`${v} will never be emailed.`); setValue(""); onDone();
        } catch (e) { onFlash(`Failed: ${(e as Error).message}`); }
      }}>Add</button>
    </div>
  );
}
