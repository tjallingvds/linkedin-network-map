/**
 * Need Approval — the one screen where every drafted email waits for a human,
 * across every board.
 *
 * Each row shows the person, the opening line that was written for them, and
 * where that line came from (a source URL, or which CRM fields), so you can
 * judge whether it's grounded in something real before anything sends. Tick the
 * ones you're happy with, press approve, and each board's people go to that
 * board's own Smartlead account.
 *
 * Nothing on this screen has been sent. Lines are only ever created as drafts,
 * and only approval releases them.
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";

interface Pending {
  id: string; name: string; company: string | null; title: string | null;
  email: string | null; openingLine: string | null; source: string | null;
  status: string | null;
  boardId: string; boardName: string; group: string; groupName: string;
  /** False = no personal line; this person would get the plain template. */
  hasLine: boolean;
}

interface JobResp { status: "running" | "done" | "error"; progress: string | null; error: string | null }

export function ApprovalsView({ onFlash }: { onFlash: (m: string) => void }) {
  const [rows, setRows] = useState<Pending[] | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = (await api.get<{ pending: Pending[] }>("/api/outreach/pending")).pending;
      setRows(r);
      // Tick the people who have a line — reviewing those is the common case.
      // Anyone without one stays unticked: sending them the plain template
      // should be a deliberate choice, not something that happens by default.
      setChecked(Object.fromEntries(r.filter((x) => x.hasLine).map((x) => [x.id, true])));
    } catch (e) { onFlash(`Couldn't load: ${(e as Error).message}`); }
  };
  /**
   * Opening the screen writes any lines that are still missing, then reloads.
   * Drafting is triggered from here rather than on a timer because it needs
   * the caller's own AI/Tavily keys, which only exist on a real request.
   */
  useEffect(() => {
    void (async () => {
      await load();
      try {
        const { undrafted } = await api.get<{ count: number; undrafted: number }>("/api/outreach/pending/count");
        if (!undrafted) return;
        setDrafting(`writing ${undrafted} opening line${undrafted === 1 ? "" : "s"}…`);
        const { jobId } = await api.post<{ jobId: string }>("/api/outreach/pending/autodraft");
        const started = Date.now();
        for (;;) {
          if (Date.now() - started > 30 * 60_000) break;
          await new Promise((r) => setTimeout(r, 2000));
          const job = await api.get<JobResp>(`/api/outreach/send/${jobId}`);
          if (job.progress) setDrafting(job.progress);
          if (job.status !== "running") break;
        }
        await load();
      } catch (e) {
        onFlash(`Couldn't write the lines: ${(e as Error).message}`);
      } finally { setDrafting(null); }
    })();
  }, []);

  const saveLine = async (id: string) => {
    const line = edits[id];
    if (line === undefined) return;
    try {
      await api.post(`/api/outreach/contacts/${id}/opener`, { line });
      setEdits((e) => { const n = { ...e }; delete n[id]; return n; });
    } catch (e) { onFlash(`Couldn't save: ${(e as Error).message}`); }
  };

  const approve = async () => {
    const ids = Object.entries(checked).filter(([, v]) => v).map(([k]) => k);
    if (!ids.length) return;
    setBusy(true);
    try {
      const r = await api.post<{ approved: number; jobIds: string[] }>(
        "/api/outreach/pending/approve-and-send", { ids });
      onFlash(`Approved ${r.approved} — sending to Smartlead now.`);
      await load();
    } catch (e) { onFlash(`Failed: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  const selected = Object.values(checked).filter(Boolean).length;

  // Group by board so it's obvious which account each batch goes through.
  const byBoard = new Map<string, Pending[]>();
  for (const r of rows ?? []) {
    if (!byBoard.has(r.boardName)) byBoard.set(r.boardName, []);
    byBoard.get(r.boardName)!.push(r);
  }

  return (
    <div className="au-wrap">
      <div className="au-hero">
        <span className="au-dot" />
        <div className="au-hero-main">
          <h2 className="au-hero-title">
            {rows === null ? "Loading…"
              : rows.length === 0 ? "Nothing waiting for you"
              : `${rows.length} email${rows.length === 1 ? " needs" : "s need"} approval`}
          </h2>
          <div className="au-hero-sub">
            Each person has their own first line, written from their LinkedIn or whatever the CRM knows
            about them. Check the line reads true, then approve — nothing has been sent yet. People with
            no line can still be ticked; they receive the campaign’s plain template.
          </div>
        </div>
        <button className="pill-btn primary" disabled={busy || !!drafting || selected === 0} onClick={approve}>
          {busy ? "Sending…" : `Approve ${selected}`}
        </button>
      </div>

      {drafting && <div className="au-empty">{drafting}</div>}

      {rows !== null && rows.length === 0 && !drafting && (
        <div className="au-empty">
          When a board has people in a group, their opening lines are drafted and appear here for you to
          approve before anything goes out.
        </div>
      )}

      {[...byBoard.entries()].map(([boardName, list]) => (
        <section key={boardName} className="au-sec">
          <div className="au-sec-head">
            <h3 className="au-sec-title">{boardName}</h3>
            <span className="au-chip">{list.length}</span>
            <span className="au-sec-hint">
              Goes through {boardName}’s own Smartlead account.
            </span>
            <button className="pill-btn" onClick={() => {
              const all = list.every((r) => checked[r.id]);
              setChecked((c) => ({ ...c, ...Object.fromEntries(list.map((r) => [r.id, !all])) }));
            }}>
              {list.every((r) => checked[r.id]) ? "Untick all" : "Tick all"}
            </button>
          </div>
          <div className="au-sec-body">
            <div className="au-table-wrap">
              <table className="au-table au-openers">
                <thead>
                  <tr><th /><th>Person</th><th>Opening line</th><th>Where it came from</th></tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.id}>
                      <td style={{ width: 28 }}>
                        <input type="checkbox" checked={!!checked[r.id]}
                          onChange={() => setChecked((c) => ({ ...c, [r.id]: !c[r.id] }))} />
                      </td>
                      <td className="au-t-name">
                        {r.name}
                        <div className="au-sub">{[r.title, r.company].filter(Boolean).join(" · ")}</div>
                        <div className="au-sub">{r.groupName || r.group}</div>
                      </td>
                      <td>
                        <textarea className="au-line" rows={2}
                          placeholder="No personal line — sends the plain template. Write one here to personalise it."
                          value={edits[r.id] ?? r.openingLine ?? ""}
                          onChange={(e) => setEdits((x) => ({ ...x, [r.id]: e.target.value }))}
                          onBlur={() => saveLine(r.id)} />
                      </td>
                      <td className="au-src">
                        {!r.hasLine
                          ? <span className="au-chip">plain template</span>
                          : r.source?.startsWith("http")
                            ? <a href={r.source} target="_blank" rel="noreferrer">{r.source}</a>
                            : (r.source ?? "—")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
