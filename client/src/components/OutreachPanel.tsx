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

/** A group as the operator defined it. `id` is internal; `name` is what shows. */
interface Group {
  id: string; name: string; description: string; prompt: string;
  /** When the current instructions were last tried on real people. */
  testedAt: string | null;
  /** Whether this group may send. False until written and tested. */
  live: boolean;
}
/** One sample line from a test run. */
interface Tryout { contactId: string; name: string; title: string | null; company: string | null; line: string | null; from: string }

interface Campaign { id: string; board_id: string; provider_campaign_id: string; tier: string; name: string | null; state: string }
interface BoardStatus {
  boardId: string; name: string; connected: boolean; enabled: boolean;
  webhookUrl: string | null; bounceLimitPct: number; bounceMinSends: number;
  stopStages: string[]; stageRules: StageRule[]; campaigns: Campaign[];
  defaultPrompt: string;
  groups: Group[];
  suppressionCount: number; unreadAlerts: number;
  lastEvent: { type: string; at: string } | null;
}
interface Readiness {
  connected: boolean; enabled: boolean; total: number; withEmail: number;
  byGroup: Record<string, number>; ready: Record<string, number>; mappedGroups: string[];
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
interface SortJob { status: "running" | "done" | "error"; progress: string | null; error: string | null; result: unknown }

/** "When <when> and the card is in <from>, move it to <to>." */
type Trigger = "sent" | "replied" | "bounced" | "unsubscribed";
interface StageRule { when: Trigger; from?: string | null; to: string }
const TRIGGERS: { id: Trigger; label: string }[] = [
  { id: "sent", label: "the email is sent" },
  { id: "replied", label: "they reply" },
  { id: "bounced", label: "it bounces" },
  { id: "unsubscribed", label: "they unsubscribe" },
];

/** "3 minutes ago" — enough precision to tell working from silent. */
function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.round(m)} minutes ago`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** A group with every field present, whatever the payload actually held. */
function normalizeGroup(g: Partial<Group>): Group {
  return {
    id: g.id ?? "",
    name: g.name ?? "",
    description: g.description ?? "",
    prompt: g.prompt ?? "",
    testedAt: g.testedAt ?? null,
    live: g.live === true,
  };
}

/** One block of the page: a title row over a hairline, then a bordered body. */
function Sec({ title, hint, chip, chipTone, muted, action, children }: {
  title: string; hint?: React.ReactNode; chip?: string;
  chipTone?: "on" | "bad"; muted?: boolean;
  /** Right-aligned control for the section, e.g. "Add group". */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={`au-sec${muted ? " is-muted" : ""}`}>
      <div className="au-sec-head">
        <h3 className="au-sec-title">{title}</h3>
        {chip && <span className={`au-chip${chipTone === "on" ? " is-on" : chipTone === "bad" ? " is-bad" : ""}`}>{chip}</span>}
        {hint && <span className="au-sec-hint">{hint}</span>}
        {action && <span className="au-sec-action">{action}</span>}
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
  const [checking, setChecking] = useState(false);

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
  const threshold = st?.bounceLimitPct ?? 2;
  const overBounce = t.sent >= (st?.bounceMinSends ?? 20) && bounceRate >= threshold;

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
        waiting={Object.values(ready?.ready ?? {}).reduce((n, v) => n + v, 0)}
        people={ready?.total ?? 0} sent={t.sent}
        onSetup={() => setShowAdvanced((v) => !v)} setupOpen={showAdvanced} />

      {/* Results, with anything wrong said right where the numbers are. */}
      <div className={`au-metric${overBounce ? " is-bad" : ""}`}>
        <div className="au-metric-head">
          <h3 className="au-sec-title">Results</h3>
        </div>
        {t.sent === 0 ? <div className="au-empty">Nothing sent yet.</div> : (
          <>
            <div className="au-big">
              <div><div className="au-big-v">{t.sent}</div><div className="au-big-k">emailed</div></div>
              <div><div className="au-big-v">{t.replied}</div><div className="au-big-k">replied</div></div>
              <div><div className="au-big-v">{replyRate}%</div><div className="au-big-k">reply rate</div></div>
              {/* Red only once it's both over the line and on enough sends to
                  mean something — below that it's noise, not a problem. */}
              <div>
                <div className={`au-big-v${overBounce ? " is-bad" : ""}`}>{bounceRate}%</div>
                <div className="au-big-k">bounced</div>
              </div>
            </div>
            <div className="au-bars">
              <Bar label="Delivered" n={t.delivered} of={t.sent} />
              <Bar label="Bounced" n={t.bounced} of={t.sent} bad={overBounce} />
              <Bar label="Unsubscribed" n={t.unsub} of={t.sent} />
            </div>
          </>
        )}
        <Warnings boardId={boardId} threshold={threshold} bounceRate={bounceRate}
          sent={t.sent} overBounce={overBounce} onFlash={onFlash} onChanged={load} />
      </div>

      {/* Groups — the core setup. */}
      <Groups boardId={boardId} campaigns={st!.campaigns} readiness={ready} groups={st!.groups ?? []}
        defaultPrompt={st!.defaultPrompt}
        disabled={!on} onChanged={load} onFlash={onFlash} />

      {/* Excluded + stop rules live behind one popup. */}
      <div className="au-inline-row">
        <button className="pill-btn" onClick={() => setSkipOpen(true)}>
          {excluded?.length ?? 0} contacts excluded
        </button>
      </div>

      {showAdvanced && (
        <>
        <div className="drawer-bg" onClick={() => setShowAdvanced(false)} />
        <div className="app-modal au-modal">
          <div className="app-modal-head">
            <span className="app-modal-title">Webhook &amp; setup</span>
            <button className="icon-btn" onClick={() => setShowAdvanced(false)}><IconClose size={16} /></button>
          </div>
          <div className="app-modal-body au-modal-body">
            <div className="au-hint">Paste into Smartlead → Settings → Webhooks.</div>
          <Row label="URL" value={setup?.webhookUrl ?? st!.webhookUrl ?? ""} onCopy={copy} />
          {setup?.webhookSecret
            ? <Row label="Secret" value={setup.webhookSecret} onCopy={copy} secret />
            : <div className="au-note">The secret is shown once — when you connect, or make a new one.</div>}
          <div className="au-note">
            Tick these four events: <b>First Email Sent</b>, <b>Email Reply</b>, <b>Email Bounce</b>,{" "}
            <b>Lead Unsubscribed</b>. Without the first one nobody is ever marked contacted;
            without the other three, sending never stops by itself.
          </div>
          {/* The only honest test of whether the URL above is right. */}
          <div className={`au-ok${st!.lastEvent ? "" : " is-waiting"}`}>
            <span>{st!.lastEvent ? "✓" : "…"}</span>
            <div>
              {st!.lastEvent
                ? <>Smartlead has called this webhook — last <b>{timeAgo(st!.lastEvent.at)}</b>{" "}
                   ({st!.lastEvent.type.toLowerCase().replace(/_/g, " ")}).</>
                : <><b>Smartlead has never called this webhook</b> — which is separate from your
                   API key working. Without it, a reply is only noticed on the next check instead
                   of within seconds, so this board is being checked every hour until one arrives.
                   Save the URL above in Smartlead and tick those four events.</>}
            </div>
          </div>
          <div className="au-actions">
            <button className="pill-btn" onClick={async () => {
              try {
                setSetup(await api.post<ConnectResp>(`/api/outreach/board/${boardId}/rotate-webhook`));
                onFlash("New secret — update Smartlead now, the old URL is dead.");
                await load();
              } catch (e) { onFlash(`Failed: ${(e as Error).message}`); }
            }}>New secret</button>
            <button className="pill-btn" disabled={checking} onClick={async () => {
              setChecking(true);
              try {
                const c = await api.post<{
                  ok: boolean; error?: string; checked: number; campaigns: number;
                  releaks: number; repliesRecovered: number; unreadable: number;
                }>(`/api/outreach/board/${boardId}/reconcile`);
                if (!c.ok) { onFlash(`Couldn’t reach Smartlead — ${c.error ?? "unknown error"}`); return; }
                if (c.unreadable) {
                  onFlash(`Couldn’t read ${c.unreadable} of ${c.campaigns} campaigns from Smartlead — check the API key.`);
                  return;
                }
                if (!c.campaigns) { onFlash("No campaign is mapped to a group yet, so there was nothing to check."); return; }
                const fixed = [
                  c.releaks ? `stopped ${c.releaks}` : "",
                  c.repliesRecovered ? `found ${c.repliesRecovered} missed ${c.repliesRecovered === 1 ? "reply" : "replies"}` : "",
                ].filter(Boolean);
                onFlash(fixed.length
                  ? `Asked Smartlead about ${c.checked} ${c.checked === 1 ? "person" : "people"} — ${fixed.join(", ")}.`
                  : `Asked Smartlead about ${c.checked} ${c.checked === 1 ? "person" : "people"} — everything matches.`);
                await load();
              } catch (e) { onFlash(`Couldn’t reach Smartlead — ${(e as Error).message}`); }
              finally { setChecking(false); }
            }}>{checking ? "Checking…" : "Re-check with Smartlead"}</button>
            <span className="au-hint" style={{ flexBasis: "100%" }}>
              Asks Smartlead who replied, who bounced and who is still sending, and fixes anything
              that drifted — a reply whose webhook never arrived, or someone still being emailed
              after you stopped them. Runs by itself too; this is for when you don't want to wait.
            </span>
            <button className="pill-btn" onClick={async () => {
              try {
                await api.post(`/api/outreach/board/${boardId}/disconnect`);
                onFlash("Disconnected. Sending is off for this board.");
                setSetup(null); await load();
              } catch (e) { onFlash(`Failed: ${(e as Error).message}`); }
            }}>Disconnect</button>
          </div>
          </div>
          <div className="app-modal-foot au-modal-foot">
            <button className="pill-btn primary" style={{ marginLeft: "auto" }}
              onClick={() => setShowAdvanced(false)}>Done</button>
          </div>
        </div>
        </>
      )}

      {skipOpen && (
        <SkipModal boardId={boardId} excluded={excluded} stages={stages} stopStages={st!.stopStages}
          stageRules={st!.stageRules ?? []}
          onClose={() => setSkipOpen(false)} onChanged={load} onFlash={onFlash} />
      )}
    </div>
  );
}

/** Status banner. */
function Hero({ on, connected, boardName, onToggle, waiting, people, sent, onSetup, setupOpen }: {
  on: boolean; connected: boolean; boardName: string;
  onToggle?: () => void; waiting?: number; people?: number; sent?: number;
  onSetup?: () => void; setupOpen?: boolean;
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
        {!on && (
          <div className="au-hero-sub">
            {connected
              ? "Nothing will be emailed from this board."
              : "Connect this board to Smartlead. Every board has its own account and its own emails."}
          </div>
        )}
        {connected && (
          <div className="au-stats">
            <div><div className="au-stat-k">In this board</div><div className="au-stat-v">{people ?? 0}</div></div>
            <div><div className="au-stat-k">Awaiting approval</div><div className="au-stat-v">{waiting ?? 0}</div></div>
            <div><div className="au-stat-k">Emailed</div><div className="au-stat-v">{sent ?? 0}</div></div>
          </div>
        )}
      </div>
      {connected && onSetup && (
        <button className="pill-btn" onClick={onSetup}>{setupOpen ? "Hide setup" : "Webhook & setup"}</button>
      )}
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
    </>
  );
}

/**
 * Groups → Smartlead campaigns, and the descriptions that decide who lands in
 * each one. You write who belongs; contacts are sorted in automatically.
 */
function Groups({ boardId, campaigns, readiness, groups, defaultPrompt, disabled, onChanged, onFlash }: {
  boardId: string; campaigns: Campaign[]; readiness: Readiness | null;
  groups: Group[]; defaultPrompt: string;
  disabled?: boolean; onChanged: () => void; onFlash: (m: string) => void;
}) {
  const [remote, setRemote] = useState<RemoteCampaign[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<Group[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [sorting, setSorting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Sample lines from the last test, per group, so the operator can read what
  // their instructions actually produce before letting them near a real inbox.
  const [tryouts, setTryouts] = useState<Record<string, Tryout[]>>({});
  const [testing, setTesting] = useState<string | null>(null);

  // Fill in anything the payload is missing before it reaches the JSX. A group
  // arriving without a description or prompt is not worth white-screening the
  // whole page over.
  const saved = JSON.stringify(groups.map(normalizeGroup));
  useEffect(() => { setDraft(JSON.parse(saved) as Group[]); }, [saved]);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try { setRemote((await api.get<{ campaigns: RemoteCampaign[] }>(`/api/outreach/board/${boardId}/campaigns/remote`)).campaigns); }
      catch (e) { onFlash(`Couldn’t load campaigns: ${(e as Error).message}`); }
      finally { setLoading(false); }
    })();
  }, [boardId]);

  const dirty = JSON.stringify(draft) !== saved;
  const described = groups.filter((g) => g.description.trim()).length;

  const edit = (i: number, patch: Partial<Group>) =>
    setDraft(draft.map((g, n) => (n === i ? { ...g, ...patch } : g)));

  const add = () => {
    setDraft([...draft, { id: "", name: "", description: "", prompt: "", testedAt: null, live: false }]);
    setOpen(`new-${draft.length}`);
  };

  const remove = (g: Group, i: number) => {
    const people = readiness?.byGroup[g.id] ?? 0;
    const warning = people
      ? `Remove “${g.name}”? Its ${people} ${people === 1 ? "person" : "people"} lose their group and stop being emailed.`
      : `Remove “${g.name}”?`;
    if (!window.confirm(warning)) return;
    setDraft(draft.filter((_, n) => n !== i));
  };

  const setCampaign = async (group: Group, providerCampaignId: string, name?: string) => {
    try {
      await api.post(`/api/outreach/board/${boardId}/campaigns`, { group: group.id, providerCampaignId, name });
      onFlash(`${group.name} will use that campaign.`);
      onChanged();
    } catch (e) { onFlash(`Failed: ${(e as Error).message}`); }
  };

  // Try the instructions on real people in the group. Saves nothing to them.
  const test = async (g: Group) => {
    setTesting(g.id);
    setNote(`Testing “${g.name}”…`);
    try {
      const { jobId } = await api.post<{ jobId: string }>(`/api/outreach/board/${boardId}/groups/${g.id}/test`);
      for (let i = 0; i < 600; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const job = await api.get<SortJob>(`/api/outreach/send/${jobId}`);
        if (job.progress) setNote(job.progress);
        if (job.status === "running") continue;
        if (job.status === "error") { onFlash(`Test failed: ${job.error ?? "unknown"}`); break; }
        const r = typeof job.result === "string" ? JSON.parse(job.result) : (job.result as { lines?: Tryout[] });
        setTryouts({ ...tryouts, [g.id]: r?.lines ?? [] });
        onFlash(`Wrote ${r?.lines?.length ?? 0} sample lines. Read them, then switch the group live.`);
        onChanged();
        break;
      }
    } catch (e) { onFlash(`Failed: ${(e as Error).message}`); }
    finally { setTesting(null); setNote(null); }
  };

  // Going live is saved on its own so it can't ride along with an unsaved edit.
  const setLive = async (g: Group, live: boolean) => {
    try {
      const next = groups.map((x) => (x.id === g.id ? { ...x, live } : x));
      await api.post(`/api/outreach/board/${boardId}/groups`, { groups: next });
      onFlash(live ? `${g.name} is live — its people can now be approved and sent.` : `${g.name} is paused.`);
      onChanged();
    } catch (e) { onFlash(`Failed: ${(e as Error).message}`); }
  };

  const save = async () => {
    try {
      const r = await api.post<{ ungrouped: number }>(`/api/outreach/board/${boardId}/groups`, { groups: draft });
      onFlash(r.ungrouped
        ? `Saved. ${r.ungrouped} ${r.ungrouped === 1 ? "person" : "people"} lost their group and won’t be emailed.`
        : "Saved. People are sorted into these automatically.");
      onChanged();
    } catch (e) { onFlash(`Failed: ${(e as Error).message}`); }
  };

  // Sorting decides who is emailable at all, so wait for it and say plainly
  // what it did — including who it refused to place.
  const sortNow = async (resort: boolean) => {
    setSorting(true);
    setNote(resort ? "Re-sorting everyone…" : "Sorting…");
    try {
      const { jobId } = await api.post<{ jobId: string }>(`/api/outreach/board/${boardId}/sort`, { resort });
      for (let i = 0; i < 600; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const job = await api.get<SortJob>(`/api/outreach/send/${jobId}`);
        if (job.progress) setNote(job.progress);
        if (job.status === "running") continue;
        if (job.status === "error") { onFlash(`Sorting failed: ${job.error ?? "unknown"}`); break; }
        const r = typeof job.result === "string" ? JSON.parse(job.result) : job.result;
        const parts = [`${r?.sorted ?? 0} sorted`];
        if (r?.unmatched) parts.push(`${r.unmatched} fit no description`);
        if (r?.failed) parts.push(`${r.failed} couldn’t be read`);
        onFlash(parts.join(", "));
        onChanged();
        break;
      }
    } catch (e) { onFlash(`Failed: ${(e as Error).message}`); }
    finally { setSorting(false); setNote(null); }
  };

  // The one thing to do next for this group, in order. Null when it's sending.
  const nextStep = (g: Group): string | null => {
    if (!g.id) return "Save it first";
    if (!g.description.trim()) return "Describe who belongs";
    if (!g.prompt.trim()) return "Write the opening line";
    if (!g.testedAt) return "Test the opening line";
    if (!g.live) return "Switch it live";
    return null;
  };

  return (
    <Sec title="Groups"
      action={
        <button className="pill-btn" disabled={disabled || draft.length >= 12} onClick={add}>
          Add group
        </button>
      }>
      {!draft.length && (
        <div className="au-empty">No groups yet. Add one and describe who belongs in it.</div>
      )}

      <div className="au-glist">
        {draft.map((g, i) => {
          const key = g.id || `new-${i}`;
          const mapped = g.id ? campaigns.find((c) => c.tier === g.id) : undefined;
          const people = g.id ? readiness?.byGroup[g.id] ?? 0 : 0;
          const step = nextStep(g);
          const isOpen = open === key;
          return (
            <div key={key} className={`au-g${isOpen ? " is-open" : ""}`}>
              {/* Collapsed: everything you need to know at a glance. */}
              <button className="au-g-head" onClick={() => setOpen(isOpen ? null : key)}>
                <span className={`au-dot${g.live ? " is-live" : ""}`} />
                <span className="au-g-name">{g.name || "Untitled group"}</span>
                <span className="au-g-meta">{people} {people === 1 ? "person" : "people"}</span>
                <span className="au-g-meta">{mapped?.name ?? (mapped ? `#${mapped.provider_campaign_id}` : "no campaign")}</span>
                <span className={`au-g-step${step ? "" : " is-done"}`}>{step ?? "Sending"}</span>
                <span className="au-g-chev">{isOpen ? "▾" : "▸"}</span>
              </button>

              {isOpen && (
                <div className="au-g-body">
                  <label className="au-f">
                    <span className="au-f-label">Name</span>
                    <input className="au-input" disabled={disabled} value={g.name}
                      placeholder="Name this group"
                      onChange={(e) => edit(i, { name: e.target.value })} />
                  </label>

                  <label className="au-f">
                    <span className="au-f-label">Who belongs</span>
                    <textarea className="au-group-desc" rows={2} disabled={disabled}
                      placeholder="e.g. Heads of AI or data at banks and insurers"
                      value={g.description}
                      onChange={(e) => edit(i, { description: e.target.value })} />
                  </label>

                  <label className="au-f">
                    <span className="au-f-label">Campaign</span>
                    <select className="au-input" disabled={disabled || loading || !g.id}
                      value={mapped?.provider_campaign_id ?? ""}
                      onChange={(e) => {
                        const id = e.target.value;
                        if (!id) return;
                        setCampaign(g, id, remote?.find((r) => String(r.id) === id)?.name);
                      }}>
                      <option value="">
                        {!g.id ? "Save first, then pick a campaign"
                          : loading ? "Loading campaigns…" : "— pick a Smartlead campaign —"}
                      </option>
                      {remote?.map((r) => <option key={r.id} value={String(r.id)}>{r.name}</option>)}
                      {mapped && !remote?.some((r) => String(r.id) === mapped.provider_campaign_id) && (
                        <option value={mapped.provider_campaign_id}>Campaign #{mapped.provider_campaign_id}</option>
                      )}
                    </select>
                  </label>

                  <label className="au-f au-f-top">
                    <span className="au-f-label">Opening line</span>
                    <span className="au-f-stack">
                      <textarea className="au-prompt" rows={5} disabled={disabled}
                        placeholder={defaultPrompt}
                        value={g.prompt}
                        onChange={(e) => edit(i, { prompt: e.target.value })} />
                      <span className="au-hint">
                        Written from their LinkedIn and your CRM notes. “Never invent” always
                        applies. Editing this takes the group off live until you test again.
                      </span>
                    </span>
                  </label>

                  <div className="au-g-foot">
                    <button className="pill-btn" disabled={disabled || !g.id || !g.prompt.trim() || dirty || testing === g.id}
                      onClick={() => void test(g)}
                      title={dirty ? "Save your changes first" : "Write sample lines for real people in this group"}>
                      {testing === g.id ? "Testing…" : g.testedAt ? "Test again" : "Test"}
                    </button>
                    <button className={`pill-btn${g.live || !g.testedAt ? "" : " primary"}`}
                      disabled={disabled || !g.id || dirty || (!g.live && !g.testedAt)}
                      onClick={() => void setLive(g, !g.live)}
                      title={!g.testedAt && !g.live ? "Test the opening line first" : ""}>
                      {g.live ? "Pause" : "Switch live"}
                    </button>
                    <button className="pill-btn au-danger" disabled={disabled}
                      style={{ marginLeft: "auto" }} onClick={() => remove(g, i)}>Remove</button>
                  </div>

                  {(tryouts[g.id] ?? []).length > 0 && (
                    <div className="au-tryout">
                      {tryouts[g.id]!.map((t) => (
                        <div key={t.contactId} className="au-tryout-row">
                          <div className="au-tryout-who">
                            {t.name}{t.title ? ` · ${t.title}` : ""}{t.company ? ` · ${t.company}` : ""}
                          </div>
                          <div className={`au-tryout-line${t.line ? "" : " is-none"}`}>
                            {t.line ?? "No line — nothing specific enough to say about them."}
                          </div>
                          <div className="au-src">{t.from}</div>
                        </div>
                      ))}
                      <div className="au-hint">
                        Samples only, saved to nobody. Real lines still wait for your approval.
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="au-actions">
        {dirty && (
          <button className="pill-btn primary" disabled={disabled} onClick={() => void save()}>
            Save changes
          </button>
        )}
        <button className="pill-btn" disabled={disabled || sorting || !described} onClick={() => void sortNow(false)}>
          Sort people into groups
        </button>
        <button className="au-link" disabled={disabled || sorting || !described} onClick={() => void sortNow(true)}>
          re-sort everyone
        </button>
        {note && <span className="au-hint">{note}</span>}
      </div>
    </Sec>
  );
}

/** Excluded contacts + the stages that stop sending, in one popup. */
function SkipModal({ boardId, excluded, stages, stopStages, stageRules, onClose, onChanged, onFlash }: {
  boardId: string; excluded: Excluded[] | null; stages: StageOption[];
  stopStages: string[]; stageRules: StageRule[];
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

          <StageRules boardId={boardId} stages={stages} current={stageRules}
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
/**
 * Card moves the email itself makes: "when the email is sent and the card is
 * in New, move it to Contacted."
 *
 * Only offers stages that exist, so a rule can't point at nothing. A rule with
 * no "from" applies wherever the card is; the first matching rule wins, which
 * is why order is visible and editable.
 */
function StageRules({ boardId, stages, current, onChanged, onFlash }: {
  boardId: string; stages: StageOption[]; current: StageRule[];
  onChanged: () => void; onFlash: (m: string) => void;
}) {
  const saved = JSON.stringify(current);
  const [rules, setRules] = useState<StageRule[]>([]);
  useEffect(() => { setRules(JSON.parse(saved) as StageRule[]); }, [saved]);

  const dirty = JSON.stringify(rules) !== saved;
  const edit = (i: number, patch: Partial<StageRule>) =>
    setRules(rules.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  const save = async () => {
    try {
      // A rule with no destination would do nothing — drop it rather than store it.
      const clean = rules.filter((r) => r.to);
      await api.post(`/api/outreach/board/${boardId}/stage-rules`, { rules: clean });
      setRules(clean);
      onFlash(clean.length ? "Card moves saved." : "Card moves cleared.");
      onChanged();
    } catch (e) { onFlash(`Failed: ${(e as Error).message}`); }
  };

  return (
    <>
      <div className="au-modal-sec">
        <h4 className="au-sec-title">Move the card automatically when…</h4>
        <span className="au-sec-hint">First matching rule wins. Nothing moves unless a rule says so.</span>
      </div>
      {!rules.length && <div className="au-empty">No automatic moves. Cards stay where you put them.</div>}
      {rules.map((r, i) => (
        <div key={i} className="au-rule">
          <span className="au-rule-w">When</span>
          <select className="au-input" value={r.when}
            onChange={(e) => edit(i, { when: e.target.value as Trigger })}>
            {TRIGGERS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <span className="au-rule-w">and the card is in</span>
          <select className="au-input" value={r.from ?? ""}
            onChange={(e) => edit(i, { from: e.target.value || null })}>
            <option value="">any stage</option>
            {stages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <span className="au-rule-w">move it to</span>
          <select className="au-input" value={r.to}
            onChange={(e) => edit(i, { to: e.target.value })}>
            <option value="">— pick a stage —</option>
            {stages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <button className="pill-btn" onClick={() => setRules(rules.filter((_, n) => n !== i))}>
            Remove
          </button>
        </div>
      ))}
      <div className="au-actions" style={{ marginTop: 10 }}>
        <button className="pill-btn primary" disabled={!dirty} onClick={() => void save()}>
          {dirty ? "Save moves" : "Saved"}
        </button>
        <button className="pill-btn" disabled={rules.length >= 20}
          onClick={() => setRules([...rules, { when: "sent", from: null, to: "" }])}>
          Add a rule
        </button>
      </div>
    </>
  );
}

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
