/**
 * CRM — multi-board pipeline (kanban + editable table), backed by the real
 * backend (`/api/crm/boards`, `/api/crm/boards/:id/contacts`, etc).
 *
 * Ported from design/project/CRMView.jsx. Board + contact state is persisted
 * server-side; the React tree just reflects it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CrmBoard, CrmContact, CrmImportRow, CrmStage, CrmTemp } from "@app/shared";
import { api } from "../lib/api";
import { initials, avatarGrad } from "../design/mockProspects";
import {
  IconList, IconSheet, IconUpload, IconNewChat, IconClose, IconCheck, IconChevD, IconArrowR,
  IconSend, IconMail, IconBookmark, IconCalendar, IconSparkle,
} from "../design/icons";

// --- Stage definitions — colors come from the design bundle. ---
const STAGES: { id: CrmStage; label: string; color: string; tint: string }[] = [
  { id: "new",       label: "New",       color: "oklch(0.72 0.04 280)", tint: "oklch(0.95 0.02 280 / 0.7)" },
  { id: "contacted", label: "Contacted", color: "oklch(0.7 0.10 240)",  tint: "oklch(0.94 0.05 240 / 0.7)" },
  { id: "replied",   label: "Replied",   color: "oklch(0.7 0.14 65)",   tint: "oklch(0.95 0.06 65 / 0.7)"  },
  { id: "meeting",   label: "Meeting",   color: "oklch(0.65 0.16 165)", tint: "oklch(0.94 0.07 165 / 0.7)" },
  { id: "closed",    label: "Closed",    color: "oklch(0.6 0.14 155)",  tint: "oklch(0.93 0.07 155 / 0.7)" },
];

// ========== CSV parsing ==========

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n" || c === "\r") {
        if (cur.length || row.length) { row.push(cur); rows.push(row); row = []; cur = ""; }
        if (c === "\r" && text[i + 1] === "\n") i++;
      } else cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
function tryParseTSV(text: string): string[][] {
  if (text.includes("\t")) return text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split("\t"));
  return parseCSV(text);
}
function mapHeader(h: string): keyof CrmImportRow | null {
  const k = h.toLowerCase().trim();
  if (/^(name|full.?name|contact)$/.test(k)) return "name";
  if (/^(title|role|position|job)/.test(k)) return "title";
  if (/^(company|org|employer|account)/.test(k)) return "company";
  if (/^(email|e-mail)/.test(k)) return "email";
  if (/^(stage|status)/.test(k)) return "stage";
  if (/^(temp|priority|rating)/.test(k)) return "temp";
  if (/^(source|list|from)/.test(k)) return "source";
  if (/^(next|next.?step|action)/.test(k)) return "nextStep";
  return null;
}
function rowsToContacts(rows: string[][]): CrmImportRow[] {
  if (!rows.length) return [];
  const header = rows[0]!.map((h) => mapHeader(h));
  const hasHeader = header.some(Boolean);
  const data = hasHeader ? rows.slice(1) : rows;
  const fallback: (keyof CrmImportRow)[] = ["name", "title", "company", "email", "stage", "temp", "source"];
  const keys = hasHeader ? header : fallback.slice(0, rows[0]!.length);
  return data.map((r) => {
    const o: CrmImportRow = { name: "" };
    r.forEach((val, j) => {
      const k = keys[j];
      if (k && val.trim()) (o as unknown as Record<string, string>)[k] = val.trim();
    });
    if (o.temp) o.temp = String(o.temp).toLowerCase();
    return o;
  }).filter((r) => r.name);
}

// ========== Pieces ==========

function KanbanCard({ p, idx, onOpen }: { p: CrmContact; idx: number; onOpen: (c: CrmContact) => void }) {
  return (
    <div className="kanban-card" onClick={() => onOpen(p)}>
      <div className="kc-top">
        <div className="kc-avatar" style={{ background: avatarGrad(idx) }}>{initials(p.name)}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="kc-name">{p.name}</div>
          <div className="kc-co">{p.company ?? ""}</div>
        </div>
        <span className={`kc-temp ${p.temp}`} title={`${p.temp} lead`} />
      </div>
      <div className="kc-role">{p.title ?? ""}</div>
      <div className="kc-stats">
        <span title="Sent"><IconSend size={10} />{p.sent}</span>
        <span title="Opens"><IconMail size={10} />{p.opens}</span>
        <span title="Replies"><IconArrowR size={10} />{p.replies}</span>
        <span className="kc-touch">{p.lastTouch ?? "—"}</span>
      </div>
      <div className="kc-next-row">
        <span className="kc-next-dot" />
        <span className="kc-next">{p.nextStep ?? "First touch"}</span>
      </div>
    </div>
  );
}

function KanbanBoard({ contacts, onOpen }: { contacts: CrmContact[]; onOpen: (c: CrmContact) => void }) {
  return (
    <div className="kanban">
      {STAGES.map((stage) => {
        const items = contacts.filter((p) => p.stage === stage.id);
        return (
          <div
            key={stage.id}
            className="kanban-col"
            style={{ "--stage-tint": stage.tint, "--stage-color": stage.color } as React.CSSProperties}
          >
            <div className="kanban-head">
              <span className="kanban-bar" />
              <span className="kanban-title">{stage.label}</span>
              <span className="kanban-count">{items.length}</span>
              <button className="kanban-add" title="Add"><IconNewChat size={12} /></button>
            </div>
            <div className="kanban-list">
              {items.map((p) => (
                <KanbanCard key={p.id} p={p} idx={contacts.indexOf(p)} onOpen={onOpen} />
              ))}
              {items.length === 0 && <button className="kanban-empty">+ Add contact</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EditableCell({
  value, onSave, align,
}: { value: string | number | null | undefined; onSave: (v: string) => void; align?: "left" | "center" }) {
  const [v, setV] = useState(value == null ? "" : String(value));
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  useEffect(() => { setV(value == null ? "" : String(value)); }, [value]);
  const commit = () => {
    setEditing(false);
    if (v !== String(value ?? "")) onSave(v);
  };
  return editing ? (
    <input
      ref={ref}
      className="ed-input"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { setV(String(value ?? "")); setEditing(false); }
      }}
      onClick={(e) => e.stopPropagation()}
      style={{ textAlign: align ?? "left" }}
    />
  ) : (
    <span
      className="ed-cell"
      onClick={(e) => { e.stopPropagation(); setEditing(true); }}
      style={{ textAlign: align ?? "left", width: "100%" }}
    >
      {v || <em style={{ color: "var(--text-mute)" }}>—</em>}
    </span>
  );
}

function StageCell({ stage, onChange }: { stage: CrmStage; onChange: (s: CrmStage) => void }) {
  const [open, setOpen] = useState(false);
  const s = STAGES.find((x) => x.id === stage) ?? STAGES[0]!;
  return (
    <div className="stage-cell" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
      <span className="tbl-stage" style={{ "--stage-color": s.color, "--stage-tint": s.tint } as React.CSSProperties}>
        {s.label}
      </span>
      {open && (
        <div className="stage-menu" onMouseLeave={() => setOpen(false)}>
          {STAGES.map((st) => (
            <button key={st.id} onClick={(e) => { e.stopPropagation(); onChange(st.id); setOpen(false); }}>
              <span className="stage-dot" style={{ background: st.color }} />
              {st.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TempCell({ temp, onChange }: { temp: CrmTemp; onChange: (t: CrmTemp) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="stage-cell" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
      <span className={`kc-temp ${temp} labeled`}>{temp}</span>
      {open && (
        <div className="stage-menu" onMouseLeave={() => setOpen(false)}>
          {(["hot", "warm", "cold"] as const).map((t) => (
            <button key={t} onClick={(e) => { e.stopPropagation(); onChange(t); setOpen(false); }}>
              <span className={`kc-temp ${t}`} />{t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TableView({
  contacts, onOpen, onPatch,
}: { contacts: CrmContact[]; onOpen: (c: CrmContact) => void; onPatch: (id: string, patch: Partial<CrmContact>) => void }) {
  return (
    <div className="tbl-wrap">
      <div className="tbl">
        <div className="tbl-row tbl-head">
          <div className="tbl-cell"></div>
          <div className="tbl-cell">Person</div>
          <div className="tbl-cell">Company</div>
          <div className="tbl-cell">Stage</div>
          <div className="tbl-cell">Temp</div>
          <div className="tbl-cell c-num">Sent</div>
          <div className="tbl-cell c-num">Opens</div>
          <div className="tbl-cell c-num">Replies</div>
          <div className="tbl-cell">Next step</div>
          <div className="tbl-cell">Last touch</div>
          <div className="tbl-cell">Source</div>
        </div>
        {contacts.map((p, i) => (
          <div key={p.id} className="tbl-row" onClick={() => onOpen(p)}>
            <div className="tbl-cell"><div className="pc-check" onClick={(e) => e.stopPropagation()} /></div>
            <div className="tbl-cell c-name">
              <div className="kc-avatar" style={{ background: avatarGrad(i), width: 24, height: 24, fontSize: 10 }}>
                {initials(p.name)}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12.5, fontWeight: 500, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {p.name}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {p.title ?? ""}
                </div>
              </div>
            </div>
            <div className="tbl-cell"><EditableCell value={p.company} onSave={(v) => onPatch(p.id, { company: v })} /></div>
            <div className="tbl-cell"><StageCell stage={p.stage} onChange={(v) => onPatch(p.id, { stage: v })} /></div>
            <div className="tbl-cell"><TempCell temp={p.temp} onChange={(v) => onPatch(p.id, { temp: v })} /></div>
            <div className="tbl-cell c-num"><EditableCell value={p.sent} align="center" onSave={(v) => onPatch(p.id, { sent: Number(v) || 0 })} /></div>
            <div className="tbl-cell c-num"><EditableCell value={p.opens} align="center" onSave={(v) => onPatch(p.id, { opens: Number(v) || 0 })} /></div>
            <div className="tbl-cell c-num"><EditableCell value={p.replies} align="center" onSave={(v) => onPatch(p.id, { replies: Number(v) || 0 })} /></div>
            <div className="tbl-cell"><EditableCell value={p.nextStep} onSave={(v) => onPatch(p.id, { nextStep: v })} /></div>
            <div className="tbl-cell">{p.lastTouch ?? "—"}</div>
            <div className="tbl-cell"><span className="src-chip">{p.source ?? ""}</span></div>
          </div>
        ))}
        {contacts.length === 0 && (
          <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-mute)", fontSize: 13 }}>
            No contacts yet. Click <strong>Import CSV</strong> to paste your spreadsheet.
          </div>
        )}
      </div>
    </div>
  );
}

function ImportModal({
  boardName, onClose, onImport,
}: { boardName: string; onClose: () => void; onImport: (rows: CrmImportRow[]) => Promise<void> }) {
  const [text, setText] = useState("");
  const [step, setStep] = useState<"paste" | "preview">("paste");
  const [saving, setSaving] = useState(false);
  const preview = useMemo(() => {
    if (!text.trim()) return [];
    return rowsToContacts(tryParseTSV(text)).slice(0, 200);
  }, [text]);
  const sample =
    "name,title,company,email,stage,temp\n" +
    "Maya Okafor,VP Engineering,Lumen AI,maya@lumen.ai,new,hot\n" +
    "Ravi Mehta,Head of Eng,Glyphic,ravi@glyphic.co,contacted,warm";

  const handleImport = async () => {
    setSaving(true);
    try {
      await onImport(preview);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <div className="import-modal">
        <div className="im-head">
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Import contacts</div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>
              Paste CSV or TSV into <strong>{boardName}</strong>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}><IconClose size={15} /></button>
        </div>
        {step === "paste" ? (
          <>
            <div className="im-body">
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginBottom: 8 }}>
                Copy from Google Sheets, Excel, Notion, or a .csv file and paste below.
                Recognized columns: <code>name, title, company, email, stage, temp, source, nextStep</code>
              </div>
              <textarea
                className="im-textarea"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={sample}
                autoFocus
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                <button className="tool" onClick={() => setText(sample)} style={{ fontSize: 11.5 }}>Load sample</button>
                <div style={{ fontSize: 11, color: "var(--text-mute)", fontFamily: "Geist Mono, monospace" }}>
                  {text.trim() ? `${preview.length} row${preview.length === 1 ? "" : "s"} detected` : "empty"}
                </div>
              </div>
            </div>
            <div className="im-foot">
              <button className="pill-btn" onClick={onClose}>Cancel</button>
              <button className="pill-btn primary" disabled={!preview.length} onClick={() => setStep("preview")}>
                Preview <IconArrowR size={12} />
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="im-body">
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginBottom: 8 }}>
                Preview — {preview.length} contact{preview.length === 1 ? "" : "s"} will be added.
              </div>
              <div className="im-preview">
                <div className="im-prev-head">
                  <span>Name</span><span>Title</span><span>Company</span><span>Stage</span><span>Temp</span>
                </div>
                {preview.slice(0, 20).map((p, i) => (
                  <div key={i} className="im-prev-row">
                    <span>{p.name || <em>—</em>}</span>
                    <span>{p.title || <em>—</em>}</span>
                    <span>{p.company || <em>—</em>}</span>
                    <span>{p.stage ?? "new"}</span>
                    <span>{p.temp ?? "warm"}</span>
                  </div>
                ))}
                {preview.length > 20 && (
                  <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-mute)" }}>
                    + {preview.length - 20} more…
                  </div>
                )}
              </div>
            </div>
            <div className="im-foot">
              <button className="pill-btn" onClick={() => setStep("paste")}>← Back</button>
              <button className="pill-btn primary" disabled={saving} onClick={handleImport}>
                <IconCheck size={12} />{saving ? "Importing…" : `Import ${preview.length}`}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function BoardSwitcher({
  boards, activeId, onSelect, onNew, onDelete,
}: {
  boards: CrmBoard[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = boards.find((b) => b.id === activeId) ?? boards[0];
  if (!active) return null;
  return (
    <div className="board-switcher">
      <button className="board-btn" onClick={() => setOpen((o) => !o)}>
        <span style={{ fontSize: 15 }}>{active.emoji}</span>
        <span className="board-name">{active.name}</span>
        <span className="board-count">{active.contactCount ?? 0}</span>
        <IconChevD size={12} />
      </button>
      {open && (
        <>
          <div className="board-menu-bg" onClick={() => setOpen(false)} />
          <div className="board-menu">
            <div className="bm-label">Boards</div>
            {boards.map((b) => (
              <button key={b.id} className={`bm-item ${b.id === activeId ? "active" : ""}`}
                onClick={() => { onSelect(b.id); setOpen(false); }}>
                <span style={{ fontSize: 15 }}>{b.emoji}</span>
                <span style={{ flex: 1, textAlign: "left" }}>{b.name}</span>
                <span className="board-count">{b.contactCount ?? 0}</span>
              </button>
            ))}
            <div className="bm-sep" />
            <button className="bm-item" onClick={() => { onNew(); setOpen(false); }}>
              <IconNewChat size={13} /><span>New board</span>
            </button>
            {boards.length > 1 && (
              <button className="bm-item" onClick={() => { onDelete(activeId); setOpen(false); }}
                style={{ color: "var(--danger, oklch(0.55 0.2 25))" }}>
                <IconClose size={13} /><span>Delete "{active.name}"</span>
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ========== CRMDrawer — per-contact side panel ==========

export function CRMDrawer({
  contact, idx, onClose, onPatch,
}: { contact: CrmContact; idx: number; onClose: () => void; onPatch: (id: string, patch: Partial<CrmContact>) => void }) {
  const [note, setNote] = useState("");
  const stage = STAGES.find((s) => s.id === contact.stage) ?? STAGES[0]!;

  const advanceStage = () => {
    const i = STAGES.findIndex((s) => s.id === contact.stage);
    const next = STAGES[Math.min(STAGES.length - 1, i + 1)]!;
    onPatch(contact.id, { stage: next.id });
  };

  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="icon-btn" onClick={onClose}><IconClose size={15} /></button>
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Contact · CRM</div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="pill-btn"><IconMail size={12} />Email</button>
            <button className="pill-btn"><IconCalendar size={12} />Schedule</button>
          </div>
        </div>
        <div className="drawer-body">
          <div className="profile-hero">
            <div className="profile-avatar" style={{ background: avatarGrad(idx) }}>{initials(contact.name)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="profile-name">{contact.name}</div>
              <div className="profile-title">{contact.title ?? ""} · {contact.company ?? ""}</div>
              <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                <span className="tbl-stage" style={{ "--stage-color": stage.color, "--stage-tint": stage.tint } as React.CSSProperties}>
                  {stage.label}
                </span>
                <span className={`kc-temp ${contact.temp} labeled`}>{contact.temp}</span>
              </div>
            </div>
          </div>

          <div>
            <div className="section-title">Outreach stats</div>
            <div className="field-grid">
              <div className="field"><div className="field-label">Sent</div><div className="field-value">{contact.sent}</div></div>
              <div className="field"><div className="field-label">Opens</div><div className="field-value">{contact.opens}</div></div>
              <div className="field"><div className="field-label">Replies</div><div className="field-value">{contact.replies}</div></div>
              <div className="field"><div className="field-label">Last touch</div><div className="field-value">{contact.lastTouch ?? "—"}</div></div>
            </div>
          </div>

          <div>
            <div className="section-title">Next step</div>
            <div style={{ padding: "9px 14px", background: "var(--panel)", border: "1px solid var(--hairline)", borderRadius: 10, fontSize: 12.5, display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-dim)" }}>Action</span>
              <span style={{ fontWeight: 500 }}>{contact.nextStep ?? "First touch"}</span>
            </div>
          </div>

          <div>
            <div className="section-title">Add note</div>
            <div style={{ display: "flex", gap: 8, padding: "10px 12px", background: "var(--panel)", border: "1px solid var(--hairline)", borderRadius: 10 }}>
              <input
                style={{ flex: 1, fontSize: 12.5 }}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Log a call, note, or what you learned…"
              />
              <button
                style={{ fontSize: 11.5, color: "var(--accent)", fontWeight: 500 }}
                onClick={() => { if (note.trim()) onPatch(contact.id, { notes: note }); setNote(""); }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
        <div className="drawer-foot">
          <button className="pill-btn" style={{ flex: 1 }} onClick={advanceStage}>
            Move to next stage <IconArrowR size={13} />
          </button>
          <button className="pill-btn primary" style={{ flex: 1 }}>
            <IconSend size={13} />Send follow-up
          </button>
        </div>
      </div>
    </>
  );
}

// ========== CRMView — top-level ==========

export function CRMView({
  viewMode, setViewMode, onFlash,
}: { viewMode: "kanban" | "table"; setViewMode: (v: "kanban" | "table") => void; onFlash: (msg: string) => void }) {
  const [boards, setBoards] = useState<CrmBoard[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [contacts, setContacts] = useState<CrmContact[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [openContact, setOpenContact] = useState<CrmContact | null>(null);
  const [loading, setLoading] = useState(true);
  const [enriching, setEnriching] = useState(false);

  // Load boards + auto-select the first one.
  useEffect(() => {
    api.get<{ boards: CrmBoard[] }>("/api/crm/boards")
      .then((r) => {
        setBoards(r.boards);
        if (r.boards[0]) setActiveId(r.boards[0].id);
      })
      .catch((e) => onFlash(`Load boards failed: ${e.message}`))
      .finally(() => setLoading(false));
  }, [onFlash]);

  // Load contacts when active board changes.
  useEffect(() => {
    if (!activeId) return;
    api.get<{ contacts: CrmContact[] }>(`/api/crm/boards/${activeId}/contacts`)
      .then((r) => setContacts(r.contacts))
      .catch((e) => onFlash(`Load contacts failed: ${e.message}`));
  }, [activeId, onFlash]);

  const active = boards.find((b) => b.id === activeId);

  const patchContact = async (id: string, patch: Partial<CrmContact>) => {
    // optimistic
    setContacts((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    try {
      const updated = await api.patch<CrmContact>(`/api/crm/contacts/${id}`, patch);
      setContacts((cs) => cs.map((c) => (c.id === id ? updated : c)));
    } catch (e) {
      onFlash(`Save failed: ${(e as Error).message}`);
    }
  };

  const addBoard = async () => {
    const name = window.prompt("New board name:", "Untitled pipeline");
    if (!name) return;
    const emojis = ["📣", "🎯", "🧲", "💼", "🌱", "🚀", "🔥", "📊", "✨", "🧭"];
    const emoji = emojis[boards.length % emojis.length];
    try {
      const b = await api.post<CrmBoard>("/api/crm/boards", { name, emoji });
      setBoards((bs) => [...bs, { ...b, contactCount: 0 }]);
      setActiveId(b.id);
      setContacts([]);
      onFlash(`Created "${name}"`);
    } catch (e) {
      onFlash(`Create board failed: ${(e as Error).message}`);
    }
  };

  const deleteBoard = async (id: string) => {
    if (boards.length <= 1) return;
    if (!window.confirm("Delete this board and all its contacts?")) return;
    try {
      await api.del(`/api/crm/boards/${id}`);
      const next = boards.filter((b) => b.id !== id);
      setBoards(next);
      setActiveId(next[0]!.id);
      onFlash("Board deleted");
    } catch (e) {
      onFlash(`Delete failed: ${(e as Error).message}`);
    }
  };

  const doImport = async (rows: CrmImportRow[]) => {
    if (!activeId) return;
    try {
      await api.post(`/api/crm/boards/${activeId}/contacts/bulk`, {
        contacts: rows.map((r) => ({
          name: r.name,
          title: r.title ?? null,
          company: r.company ?? null,
          email: r.email ?? null,
          stage: (r.stage && ["new", "contacted", "replied", "meeting", "closed"].includes(r.stage)) ? r.stage : "new",
          temp: (r.temp && ["hot", "warm", "cold"].includes(r.temp)) ? r.temp : "warm",
          source: r.source ?? "CSV import",
          nextStep: r.nextStep ?? "First touch",
        })),
      });
      // Reload contacts + board counts.
      const [cs, bs] = await Promise.all([
        api.get<{ contacts: CrmContact[] }>(`/api/crm/boards/${activeId}/contacts`),
        api.get<{ boards: CrmBoard[] }>("/api/crm/boards"),
      ]);
      setContacts(cs.contacts);
      setBoards(bs.boards);
      onFlash(`Imported ${rows.length} contact${rows.length === 1 ? "" : "s"}`);
    } catch (e) {
      onFlash(`Import failed: ${(e as Error).message}`);
    }
  };

  const addContact = async () => {
    if (!activeId) return;
    const name = window.prompt("Contact name:");
    if (!name) return;
    try {
      const c = await api.post<CrmContact>(`/api/crm/boards/${activeId}/contacts`, { name });
      setContacts((cs) => [...cs, c]);
      setBoards((bs) => bs.map((b) => b.id === activeId ? { ...b, contactCount: (b.contactCount ?? 0) + 1 } : b));
    } catch (e) {
      onFlash(`Add contact failed: ${(e as Error).message}`);
    }
  };

  const enrichAll = async () => {
    if (!activeId || enriching) return;
    if (contacts.length === 0) { onFlash("No contacts to enrich yet."); return; }
    setEnriching(true);
    try {
      const r = await api.post<{ enriched: number; skipped: number; total: number }>(
        `/api/crm/boards/${activeId}/enrich`,
      );
      // Reload contacts to reflect changes.
      const fresh = await api.get<{ contacts: CrmContact[] }>(`/api/crm/boards/${activeId}/contacts`);
      setContacts(fresh.contacts);
      onFlash(`Enriched ${r.enriched} of ${r.total} (${r.skipped} had no Apollo match)`);
    } catch (e) {
      onFlash(`Enrich failed: ${(e as Error).message}`);
    } finally {
      setEnriching(false);
    }
  };

  if (loading) return <div style={{ padding: 24, color: "var(--text-dim)" }}>Loading CRM…</div>;
  if (!active) return <div style={{ padding: 24, color: "var(--text-dim)" }}>No boards yet.</div>;

  return (
    <div className="crm-wrap">
      <div className="crm-toolbar">
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <BoardSwitcher
            boards={boards}
            activeId={activeId}
            onSelect={setActiveId}
            onNew={addBoard}
            onDelete={deleteBoard}
          />
          <div className="view-toggle">
            <button className={viewMode === "kanban" ? "active" : ""} onClick={() => setViewMode("kanban")}>
              <IconList size={12} style={{ transform: "rotate(90deg)" }} />Board
            </button>
            <button className={viewMode === "table" ? "active" : ""} onClick={() => setViewMode("table")}>
              <IconSheet size={12} />Table
            </button>
          </div>
        </div>
        <div className="crm-tools">
          <button className="pill-btn" disabled={enriching} onClick={enrichAll} title="Enrich all contacts on this board via Apollo.io">
            <IconSparkle size={12} />{enriching ? "Enriching…" : "Enrich all"}
          </button>
          <button className="pill-btn" onClick={() => setImportOpen(true)}>
            <IconUpload size={12} />Import CSV
          </button>
          <button className="pill-btn primary" onClick={addContact}>
            <IconNewChat size={12} />Add contact
          </button>
        </div>
      </div>

      {viewMode === "kanban" ? (
        <KanbanBoard contacts={contacts} onOpen={setOpenContact} />
      ) : (
        <TableView contacts={contacts} onOpen={setOpenContact} onPatch={patchContact} />
      )}

      {importOpen && (
        <ImportModal
          boardName={active.name}
          onClose={() => setImportOpen(false)}
          onImport={doImport}
        />
      )}

      {openContact && (
        <CRMDrawer
          contact={openContact}
          idx={contacts.findIndex((c) => c.id === openContact.id)}
          onClose={() => setOpenContact(null)}
          onPatch={(id, patch) => {
            patchContact(id, patch);
            setOpenContact((c) => (c && c.id === id ? { ...c, ...patch } : c));
          }}
        />
      )}
    </div>
  );
}

// Also re-export the Bookmark icon for activity rows (kept for future use).
export { IconBookmark };
