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
import { useModal } from "./Modal";
import { initials, avatarGrad } from "../design/mockProspects";
import {
  IconList, IconSheet, IconUpload, IconNewChat, IconClose, IconCheck, IconChevD, IconArrowR,
  IconSend, IconMail, IconSparkle, IconLinkedIn,
} from "../design/icons";

// ========== Column configuration ==========

/**
 * Every table column is described here — id, label, width (passed to the grid
 * template), render function, and alwaysVisible flag for columns the user
 * can't hide (the selection checkbox + the person column).
 *
 * Visibility + order per-board are persisted in localStorage under
 * "crm.cols.v1.<boardId>" as a string[] of column ids in the desired order.
 */
export interface TableColumnDef {
  id: string;
  label: string;
  width: string;
  alwaysVisible?: boolean;
  numeric?: boolean;
}

const TABLE_COLUMNS: TableColumnDef[] = [
  { id: "_select",  label: "",           width: "36px",   alwaysVisible: true },
  { id: "person",   label: "Person",     width: "1.8fr",  alwaysVisible: true },
  { id: "title",    label: "Title",      width: "1.1fr" },
  { id: "company",  label: "Company",    width: "1.1fr" },
  { id: "email",    label: "Email",      width: "1.2fr" },
  { id: "phone",    label: "Phone",      width: "130px" },
  { id: "stage",    label: "Stage",      width: "120px" },
  { id: "temp",     label: "Temp",       width: "90px"  },
  { id: "sent",     label: "Sent",       width: "64px",  numeric: true },
  { id: "opens",    label: "Opens",      width: "64px",  numeric: true },
  { id: "replies",  label: "Replies",    width: "64px",  numeric: true },
  { id: "nextStep", label: "Next step",  width: "1.3fr" },
  { id: "source",   label: "Source",     width: "1fr"   },
  { id: "messageNotes", label: "Personalize", width: "1.5fr" },
  { id: "notes",    label: "Notes",      width: "1.5fr" },
];

const BUILTIN_COL_IDS = TABLE_COLUMNS.map((c) => c.id);
const REQUIRED_COLS = TABLE_COLUMNS.filter((c) => c.alwaysVisible).map((c) => c.id);

/** User-defined column. Values live in contact.customFields[id]. */
export interface CustomColumn {
  id: string;
  label: string;
  /** Width used in grid-template-columns. Defaults to "1fr" for text. */
  width?: string;
}

function colsKey(boardId: string) { return `crm.cols.v1.${boardId}`; }
function customColsKey(boardId: string) { return `crm.customcols.v1.${boardId}`; }

function loadCustomCols(boardId: string): CustomColumn[] {
  if (!boardId) return [];
  try {
    const raw = localStorage.getItem(customColsKey(boardId));
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return (arr as CustomColumn[]).filter((c) => c && typeof c.id === "string" && typeof c.label === "string");
  } catch { return []; }
}
function saveCustomCols(boardId: string, cols: CustomColumn[]) {
  if (!boardId) return;
  try { localStorage.setItem(customColsKey(boardId), JSON.stringify(cols)); } catch { /* noop */ }
}

function loadColsConfig(boardId: string, customIds: string[]): string[] {
  const all = [...BUILTIN_COL_IDS, ...customIds];
  if (!boardId) return all;
  try {
    const raw = localStorage.getItem(colsKey(boardId));
    if (!raw) return all;
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return all;
    const valid = (arr as string[]).filter((id) => all.includes(id));
    const required = REQUIRED_COLS.filter((id) => !valid.includes(id));
    return [...required, ...valid];
  } catch { return all; }
}

function saveColsConfig(boardId: string, ids: string[]) {
  if (!boardId) return;
  try { localStorage.setItem(colsKey(boardId), JSON.stringify(ids)); } catch { /* noop */ }
}

/** Turn a free-form label into a stable id: "Lead score" → "lead-score-<rnd>". */
function makeCustomColId(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "col";
  return `c_${slug}_${Math.random().toString(36).slice(2, 7)}`;
}

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
// Columns that need special merging (e.g. LinkedIn's export has First/Last Name).
type ColKey = keyof CrmImportRow | "firstName" | "lastName";
function mapHeader(h: string): ColKey | null {
  const k = h.toLowerCase().trim();
  if (/^(name|full.?name|contact)$/.test(k)) return "name";
  if (/^first.?name$/.test(k)) return "firstName";
  if (/^last.?name$/.test(k)) return "lastName";
  if (/^(title|role|position|job)/.test(k)) return "title";
  if (/^(company|org|employer|account)/.test(k)) return "company";
  if (/^(email|e-mail)/.test(k)) return "email";
  if (/^(phone|mobile|tel)/.test(k)) return "phone";
  if (/^(linked[-_ ]?in|li[-_ ]?url|profile[-_ ]?url|url)$/.test(k)) return "linkedin";
  if (/^(note|notes|comment)/.test(k)) return "notes";
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
  const fallback: ColKey[] = ["name", "title", "company", "email", "stage", "temp", "source"];
  const keys = hasHeader ? header : fallback.slice(0, rows[0]!.length);
  return data.map((r) => {
    const bag: Record<string, string> = {};
    r.forEach((val, j) => {
      const k = keys[j];
      const v = (val ?? "").trim();
      if (k && v) bag[k] = v;
    });
    // Merge first+last into name when the header split them.
    if (!bag.name && (bag.firstName || bag.lastName)) {
      bag.name = [bag.firstName, bag.lastName].filter(Boolean).join(" ").trim();
    }
    delete bag.firstName;
    delete bag.lastName;
    if (bag.temp) bag.temp = bag.temp.toLowerCase();
    return bag as unknown as CrmImportRow;
  }).filter((r) => r.name);
}

// ========== Pieces ==========

function KanbanCard({
  p, idx, onOpen, onDelete, onDragStart, onDragEnd, dragging,
}: {
  p: CrmContact;
  idx: number;
  onOpen: (c: CrmContact) => void;
  onDelete: (id: string) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  dragging: boolean;
}) {
  const modal = useModal();
  return (
    <div
      className={`kanban-card${dragging ? " dragging" : ""}`}
      onClick={() => onOpen(p)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", p.id);
        onDragStart(p.id);
      }}
      onDragEnd={onDragEnd}
    >
      <button
        className="kc-delete"
        title="Delete contact"
        onClick={async (e) => {
          e.stopPropagation();
          const ok = await modal.confirm({
            title: `Delete "${p.name}"?`,
            message: "Remove this contact from the board.",
            confirmLabel: "Delete",
            destructive: true,
          });
          if (ok) onDelete(p.id);
        }}
      >
        <IconClose size={11} />
      </button>
      <div className="kc-top">
        <div className="kc-avatar" style={{ background: avatarGrad(idx) }}>{initials(p.name)}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="kc-name">{p.name}</div>
          {p.title && <div className="kc-role">{p.title}</div>}
          {p.company && <div className="kc-co">{p.company}</div>}
        </div>
      </div>
    </div>
  );
}

function KanbanBoard({
  contacts, onOpen, onMoveStage, onDelete,
}: {
  contacts: CrmContact[];
  onOpen: (c: CrmContact) => void;
  onMoveStage: (contactId: string, stage: CrmStage) => void;
  onDelete: (id: string) => void;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<CrmStage | null>(null);

  return (
    <div className="kanban">
      {STAGES.map((stage) => {
        const items = contacts.filter((p) => p.stage === stage.id);
        const isOver = overStage === stage.id && draggingId != null;
        return (
          <div
            key={stage.id}
            className={`kanban-col${isOver ? " drag-over" : ""}`}
            style={{ "--stage-tint": stage.tint, "--stage-color": stage.color } as React.CSSProperties}
            onDragOver={(e) => {
              if (!draggingId) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (overStage !== stage.id) setOverStage(stage.id);
            }}
            onDragLeave={() => { if (overStage === stage.id) setOverStage(null); }}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData("text/plain") || draggingId;
              setOverStage(null);
              setDraggingId(null);
              if (id) {
                const src = contacts.find((c) => c.id === id);
                if (src && src.stage !== stage.id) onMoveStage(id, stage.id);
              }
            }}
          >
            <div className="kanban-head">
              <span className="kanban-bar" />
              <span className="kanban-title">{stage.label}</span>
              <span className="kanban-count">{items.length}</span>
              <button className="kanban-add" title="Add"><IconNewChat size={12} /></button>
            </div>
            <div className="kanban-list">
              {items.map((p) => (
                <KanbanCard
                  key={p.id}
                  p={p}
                  idx={contacts.indexOf(p)}
                  onOpen={onOpen}
                  onDelete={onDelete}
                  onDragStart={(id) => setDraggingId(id)}
                  onDragEnd={() => { setDraggingId(null); setOverStage(null); }}
                  dragging={draggingId === p.id}
                />
              ))}
              {items.length === 0 && (
                <div className={`kanban-empty${isOver ? " drop-target" : ""}`}>
                  {isOver ? "Drop to move here" : "— empty —"}
                </div>
              )}
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
  contacts, onOpen, onPatch, columns, customCols,
}: {
  contacts: CrmContact[];
  onOpen: (c: CrmContact) => void;
  onPatch: (id: string, patch: Partial<CrmContact>) => void;
  /** Ordered list of visible column ids. */
  columns: string[];
  customCols: CustomColumn[];
}) {
  // Build the full registry (builtins + custom) on the fly so custom columns
  // get TableColumnDef shape without special-casing callsites.
  const customDefs: TableColumnDef[] = customCols.map((c) => ({
    id: c.id,
    label: c.label,
    width: c.width ?? "1fr",
  }));
  const registry = [...TABLE_COLUMNS, ...customDefs];
  const colDefs = useMemo(
    () => columns.map((id) => registry.find((c) => c.id === id)).filter((c): c is TableColumnDef => !!c),
    [columns, customCols],
  );
  const gridTemplate = colDefs.map((c) => c.width).join(" ");

  const isCustom = (id: string) => customCols.some((c) => c.id === id);

  const renderCell = (col: TableColumnDef, p: CrmContact, i: number) => {
    if (isCustom(col.id)) {
      const val = (p.customFields ?? {})[col.id] ?? "";
      // Only send the diff — the server merges with the existing bag so
      // unrelated keys stay intact.
      return (
        <EditableCell
          value={val}
          onSave={(v) => onPatch(p.id, { customFields: { [col.id]: v } })}
        />
      );
    }
    switch (col.id) {
      case "_select":
        return <div className="pc-check" onClick={(e) => e.stopPropagation()} />;
      case "person":
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, width: "100%" }}>
            <div className="kc-avatar" style={{ background: avatarGrad(i), width: 24, height: 24, fontSize: 10 }}>
              {initials(p.name)}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <EditableCell value={p.name} onSave={(v) => { if (v.trim()) onPatch(p.id, { name: v.trim() }); }} />
            </div>
          </div>
        );
      case "title":   return <EditableCell value={p.title}   onSave={(v) => onPatch(p.id, { title: v })} />;
      case "company": return <EditableCell value={p.company} onSave={(v) => onPatch(p.id, { company: v })} />;
      case "email":   return <EditableCell value={p.email}   onSave={(v) => onPatch(p.id, { email: v })} />;
      case "phone":   return <EditableCell value={p.phone}   onSave={(v) => onPatch(p.id, { phone: v })} />;
      case "stage":   return <StageCell stage={p.stage} onChange={(v) => onPatch(p.id, { stage: v })} />;
      case "temp":    return <TempCell  temp={p.temp}   onChange={(v) => onPatch(p.id, { temp: v })} />;
      case "sent":    return <EditableCell value={p.sent}    align="center" onSave={(v) => onPatch(p.id, { sent: Number(v) || 0 })} />;
      case "opens":   return <EditableCell value={p.opens}   align="center" onSave={(v) => onPatch(p.id, { opens: Number(v) || 0 })} />;
      case "replies": return <EditableCell value={p.replies} align="center" onSave={(v) => onPatch(p.id, { replies: Number(v) || 0 })} />;
      case "nextStep":return <EditableCell value={p.nextStep} onSave={(v) => onPatch(p.id, { nextStep: v })} />;
      case "source":  return <span className="src-chip">{p.source ?? ""}</span>;
      case "messageNotes": return <EditableCell value={p.messageNotes} onSave={(v) => onPatch(p.id, { messageNotes: v })} />;
      case "notes":   return <EditableCell value={p.notes} onSave={(v) => onPatch(p.id, { notes: v })} />;
      default:        return null;
    }
  };

  return (
    <div className="tbl-wrap">
      <div className="tbl">
        <div className="tbl-row tbl-head" style={{ gridTemplateColumns: gridTemplate }}>
          {colDefs.map((c) => (
            <div key={c.id} className={`tbl-cell${c.numeric ? " c-num" : ""}`}>{c.label}</div>
          ))}
        </div>
        {contacts.map((p, i) => (
          <div
            key={p.id}
            className="tbl-row"
            onClick={() => onOpen(p)}
            style={{ gridTemplateColumns: gridTemplate }}
          >
            {colDefs.map((c) => (
              <div key={c.id} className={`tbl-cell${c.numeric ? " c-num" : ""}${c.id === "person" ? " c-name" : ""}`}>
                {renderCell(c, p, i)}
              </div>
            ))}
          </div>
        ))}
        {contacts.length === 0 && (
          <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-mute)", fontSize: 13 }}>
            No contacts yet. Click <strong>Import CSV</strong> to paste your spreadsheet, or <strong>Add contact</strong> to create one.
          </div>
        )}
      </div>
    </div>
  );
}

/** Dropdown menu for toggling column visibility per board AND managing
 *  user-defined custom columns. Visibility state + custom defs both persist
 *  in localStorage, keyed by board id. */
function ColumnsMenu({
  boardId, value, onChange, customCols, onCustomColsChange,
}: {
  boardId: string;
  value: string[];
  onChange: (next: string[]) => void;
  customCols: CustomColumn[];
  onCustomColsChange: (next: CustomColumn[]) => void;
}) {
  const modal = useModal();
  const [open, setOpen] = useState(false);
  const toggle = (id: string) => {
    const isBuiltIn = TABLE_COLUMNS.find((c) => c.id === id);
    if (isBuiltIn?.alwaysVisible) return;
    const next = value.includes(id) ? value.filter((x) => x !== id) : [...value, id];
    onChange(next);
    saveColsConfig(boardId, next);
  };
  const reset = () => {
    const all = [...BUILTIN_COL_IDS, ...customCols.map((c) => c.id)];
    onChange(all);
    saveColsConfig(boardId, all);
  };
  const addCustom = async () => {
    const label = await modal.prompt({
      title: "Add column",
      label: "Column name",
      placeholder: "e.g. Lead score",
      confirmLabel: "Add column",
    });
    if (!label) return;
    const id = makeCustomColId(label);
    const nextCols = [...customCols, { id, label, width: "1fr", type: "text" as const }];
    onCustomColsChange(nextCols);
    saveCustomCols(boardId, nextCols);
    const nextVisible = [...value, id];
    onChange(nextVisible);
    saveColsConfig(boardId, nextVisible);
  };
  const removeCustom = async (id: string) => {
    const col = customCols.find((c) => c.id === id);
    const ok = await modal.confirm({
      title: `Remove "${col?.label ?? "column"}"?`,
      message: "Data stored in this column is kept on each contact but hidden.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    const nextCols = customCols.filter((c) => c.id !== id);
    onCustomColsChange(nextCols);
    saveCustomCols(boardId, nextCols);
    const nextVisible = value.filter((v) => v !== id);
    onChange(nextVisible);
    saveColsConfig(boardId, nextVisible);
  };
  const renameCustom = async (id: string) => {
    const existing = customCols.find((c) => c.id === id);
    if (!existing) return;
    const label = await modal.prompt({
      title: "Rename column",
      label: "New name",
      defaultValue: existing.label,
      confirmLabel: "Rename",
    });
    if (!label) return;
    const nextCols = customCols.map((c) => (c.id === id ? { ...c, label } : c));
    onCustomColsChange(nextCols);
    saveCustomCols(boardId, nextCols);
  };

  return (
    <div style={{ position: "relative" }}>
      <button className="pill-btn" title="Show/hide + add columns" onClick={() => setOpen((o) => !o)}>
        <IconSheet size={12} />Columns
      </button>
      {open && (
        <>
          <div className="board-menu-bg" onClick={() => setOpen(false)} />
          <div className="board-menu" style={{ minWidth: 240, right: 0, left: "auto", maxHeight: "70vh", overflowY: "auto" }}>
            <div className="bm-label">Built-in</div>
            {TABLE_COLUMNS.filter((c) => c.id !== "_select").map((c) => {
              const on = value.includes(c.id);
              const locked = c.alwaysVisible;
              return (
                <button
                  key={c.id}
                  className="bm-item"
                  onClick={() => toggle(c.id)}
                  disabled={locked}
                  style={locked ? { opacity: 0.5, cursor: "default" } : undefined}
                >
                  <ColCheckbox on={on} />
                  <span style={{ flex: 1, textAlign: "left" }}>{c.label}</span>
                  {locked && <span style={{ fontSize: 10, color: "var(--text-mute)" }}>locked</span>}
                </button>
              );
            })}
            {customCols.length > 0 && <>
              <div className="bm-sep" />
              <div className="bm-label">Your columns</div>
              {customCols.map((c) => {
                const on = value.includes(c.id);
                return (
                  <div key={c.id} className="bm-item" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button
                      style={{ display: "flex", gap: 8, flex: 1, alignItems: "center", textAlign: "left", padding: 0, background: "none", border: 0, cursor: "pointer", color: "inherit" }}
                      onClick={() => toggle(c.id)}
                    >
                      <ColCheckbox on={on} />
                      <span>{c.label}</span>
                    </button>
                    <button
                      title="Rename"
                      onClick={(e) => { e.stopPropagation(); renameCustom(c.id); }}
                      style={{ fontSize: 10.5, color: "var(--text-mute)", padding: "2px 6px", borderRadius: 4 }}
                    >
                      rename
                    </button>
                    <button
                      title="Remove"
                      onClick={(e) => { e.stopPropagation(); removeCustom(c.id); }}
                      style={{ fontSize: 10.5, color: "var(--danger, oklch(0.55 0.2 25))", padding: "2px 6px", borderRadius: 4 }}
                    >
                      remove
                    </button>
                  </div>
                );
              })}
            </>}
            <div className="bm-sep" />
            <button className="bm-item" onClick={addCustom}>
              <IconNewChat size={13} /><span>Add column…</span>
            </button>
            <button className="bm-item" onClick={reset}>
              <IconArrowR size={13} /><span>Show all</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ColCheckbox({ on }: { on: boolean }) {
  return (
    <span
      style={{
        width: 14, height: 14, borderRadius: 4, flexShrink: 0,
        border: "1.5px solid var(--hairline-strong)",
        background: on ? "var(--accent)" : "transparent",
        display: "grid", placeItems: "center", color: "white",
      }}
    >
      {on && <IconCheck size={10} />}
    </span>
  );
}

export interface ImportOptions {
  destination: "active" | "new";
  newBoardName: string;
  newBoardEmoji: string;
  autoEnrich: boolean;
}

function ImportModal({
  boardName, onClose, onImport,
}: { boardName: string; onClose: () => void; onImport: (rows: CrmImportRow[], opts: ImportOptions) => Promise<void> }) {
  const [text, setText] = useState("");
  const [step, setStep] = useState<"paste" | "preview">("paste");
  const [saving, setSaving] = useState(false);
  const [destination, setDestination] = useState<"active" | "new">("active");
  const [newBoardName, setNewBoardName] = useState("");
  const [newBoardEmoji, setNewBoardEmoji] = useState("📣");
  const [autoEnrich, setAutoEnrich] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const preview = useMemo(() => {
    if (!text.trim()) return [];
    return rowsToContacts(tryParseTSV(text)).slice(0, 200);
  }, [text]);
  const sample =
    "name,title,company,email,linkedin,stage,temp\n" +
    "Maya Okafor,VP Engineering,Lumen AI,maya@lumen.ai,https://linkedin.com/in/maya,new,hot\n" +
    "Ravi Mehta,Head of Eng,Glyphic,ravi@glyphic.co,,contacted,warm";

  const EMOJIS = ["📣", "🎯", "🧲", "💼", "🌱", "🚀", "🔥", "📊", "✨", "🧭", "⭐", "📌"];

  const onPickFile = async (file: File) => {
    const raw = await file.text();
    setText(raw);
    // Default the new-board name to the file's stem when the user hasn't typed one.
    if (!newBoardName) {
      const stem = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
      if (stem) setNewBoardName(stem.slice(0, 60));
    }
  };

  const handleImport = async () => {
    setSaving(true);
    try {
      await onImport(preview, {
        destination,
        newBoardName: newBoardName.trim() || "Imported list",
        newBoardEmoji,
        autoEnrich,
      });
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
              {destination === "active"
                ? <>Paste CSV/TSV or upload a file into <strong>{boardName}</strong></>
                : <>Create a new board from a CSV/TSV file or paste</>}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}><IconClose size={15} /></button>
        </div>
        {step === "paste" ? (
          <>
            <div className="im-body">
              <div className="im-dest-row" style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                <button
                  className={`pill-btn ${destination === "active" ? "primary" : ""}`}
                  onClick={() => setDestination("active")}
                  style={{ fontSize: 11.5 }}
                >
                  Add to "{boardName}"
                </button>
                <button
                  className={`pill-btn ${destination === "new" ? "primary" : ""}`}
                  onClick={() => setDestination("new")}
                  style={{ fontSize: 11.5 }}
                >
                  <IconNewChat size={12} />Create new board
                </button>
              </div>

              {destination === "new" && (
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 10 }}>
                  <select
                    value={newBoardEmoji}
                    onChange={(e) => setNewBoardEmoji(e.target.value)}
                    style={{ fontSize: 15, padding: "6px 8px", border: "1px solid var(--hairline)", borderRadius: 8, background: "var(--panel)" }}
                  >
                    {EMOJIS.map((e) => <option key={e} value={e}>{e}</option>)}
                  </select>
                  <input
                    value={newBoardName}
                    onChange={(e) => setNewBoardName(e.target.value)}
                    placeholder="New board name"
                    style={{ flex: 1, fontSize: 12.5, padding: "7px 10px", border: "1px solid var(--hairline)", borderRadius: 8, background: "var(--panel)" }}
                  />
                </div>
              )}

              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginBottom: 8 }}>
                Copy from Google Sheets, Excel, Notion, or upload a .csv / .tsv / .txt file.
                Recognized columns: <code>name, title, company, email, phone, linkedin, stage, temp, source, nextStep, notes</code>
              </div>
              <textarea
                className="im-textarea"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Paste CSV or TSV here… (or click Load sample / Upload file below)"
                autoFocus
              />
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onPickFile(f);
                  e.target.value = "";
                }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, gap: 8 }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="tool" onClick={() => fileRef.current?.click()} style={{ fontSize: 11.5 }}>
                    <IconUpload size={12} />Upload file
                  </button>
                  <button className="tool" onClick={() => setText(sample)} style={{ fontSize: 11.5 }}>Load sample</button>
                </div>
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
                Preview — {preview.length} contact{preview.length === 1 ? "" : "s"} will be added
                {destination === "new" ? <> to a new board <strong>{newBoardEmoji} {newBoardName.trim() || "Imported list"}</strong></> : <> to <strong>{boardName}</strong></>}.
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
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: 12, color: "var(--text-dim)", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={autoEnrich}
                  onChange={(e) => setAutoEnrich(e.target.checked)}
                />
                <IconSparkle size={12} style={{ color: "var(--accent)" }} />
                Run Apollo enrichment after import (fills missing email / phone / LinkedIn)
              </label>
            </div>
            <div className="im-foot">
              <button className="pill-btn" onClick={() => setStep("paste")}>← Back</button>
              <button className="pill-btn primary" disabled={saving} onClick={handleImport}>
                <IconCheck size={12} />{saving
                  ? (autoEnrich ? "Importing & enriching…" : "Importing…")
                  : (autoEnrich ? `Import & enrich ${preview.length}` : `Import ${preview.length}`)}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** Label + editable value row used in CRMDrawer. */
function DrawerField({ label, children, block }: { label: string; children: React.ReactNode; block?: boolean }) {
  return (
    <div className={`drawer-field${block ? " block" : ""}`}>
      <div className="drawer-field-label">{label}</div>
      <div className="drawer-field-value">{children}</div>
    </div>
  );
}

function AddContactModal({
  boardName, onClose, onAdd,
}: {
  boardName: string;
  onClose: () => void;
  onAdd: (d: { name: string; title?: string; company?: string; email?: string }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => { firstRef.current?.focus(); }, []);

  const canSave = name.trim().length > 0 && !saving;
  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onAdd({
        name: name.trim(),
        title: title.trim() || undefined,
        company: company.trim() || undefined,
        email: email.trim() || undefined,
      });
    } finally { setSaving(false); }
  };

  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <div className="import-modal">
        <div className="im-head">
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Add contact</div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>
              New contact in <strong>{boardName}</strong>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}><IconClose size={15} /></button>
        </div>
        <div className="im-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Field label="Name" required>
            <input ref={firstRef} value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && canSave) submit(); }}
              placeholder="e.g. Maya Okafor" style={{ padding: "8px 10px", background: "var(--panel)", border: "1px solid var(--hairline)", borderRadius: 8, fontSize: 12.5, color: "var(--text)" }}/>
          </Field>
          <Field label="Title">
            <input value={title} onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && canSave) submit(); }}
              placeholder="e.g. VP Engineering" style={{ padding: "8px 10px", background: "var(--panel)", border: "1px solid var(--hairline)", borderRadius: 8, fontSize: 12.5, color: "var(--text)" }}/>
          </Field>
          <Field label="Company">
            <input value={company} onChange={(e) => setCompany(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && canSave) submit(); }}
              placeholder="e.g. Lumen AI" style={{ padding: "8px 10px", background: "var(--panel)", border: "1px solid var(--hairline)", borderRadius: 8, fontSize: 12.5, color: "var(--text)" }}/>
          </Field>
          <Field label="Email">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && canSave) submit(); }}
              placeholder="maya@lumen.ai" style={{ padding: "8px 10px", background: "var(--panel)", border: "1px solid var(--hairline)", borderRadius: 8, fontSize: 12.5, color: "var(--text)" }}/>
          </Field>
        </div>
        <div className="im-foot">
          <button className="pill-btn" onClick={onClose}>Cancel</button>
          <button className="pill-btn primary" disabled={!canSave} onClick={submit}>
            <IconCheck size={12} />{saving ? "Adding…" : "Add contact"}
          </button>
        </div>
      </div>
    </>
  );
}

function Field({ label, children, required }: { label: string; children: React.ReactNode; required?: boolean }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-mute)" }}>
        {label}{required ? " *" : ""}
      </span>
      {children}
    </label>
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
  contact, idx, onClose, onPatch, onDelete, customCols = [],
}: {
  contact: CrmContact;
  idx: number;
  onClose: () => void;
  onPatch: (id: string, patch: Partial<CrmContact>) => void;
  onDelete?: (id: string) => void;
  /** User-defined board columns so the drawer shows the same fields as the table. */
  customCols?: CustomColumn[];
}) {
  const modal = useModal();
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
            {contact.linkedin && (
              <a
                className="pill-btn"
                href={contact.linkedin}
                target="_blank"
                rel="noopener noreferrer"
                title="Open LinkedIn profile"
              >
                <IconLinkedIn size={12} />LinkedIn
              </a>
            )}
            {contact.email && (
              <a className="pill-btn" href={`mailto:${contact.email}`} title={`Email ${contact.email}`}>
                <IconMail size={12} />Email
              </a>
            )}
          </div>
        </div>
        <div className="drawer-body">
          <div className="profile-hero">
            <div className="profile-avatar" style={{ background: avatarGrad(idx) }}>{initials(contact.name)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="profile-name">{contact.name}</div>
              <div className="profile-title">{[contact.title, contact.company].filter(Boolean).join(" · ") || "—"}</div>
              <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                <StageCell stage={contact.stage} onChange={(v) => onPatch(contact.id, { stage: v })} />
                <TempCell temp={contact.temp} onChange={(v) => onPatch(contact.id, { temp: v })} />
              </div>
            </div>
          </div>

          {/* Every field editable inline, including the user's custom columns. */}
          <div className="drawer-fields">
            <DrawerField label="Name">
              <EditableCell value={contact.name} onSave={(v) => { if (v.trim()) onPatch(contact.id, { name: v.trim() }); }} />
            </DrawerField>
            <DrawerField label="Title">
              <EditableCell value={contact.title} onSave={(v) => onPatch(contact.id, { title: v })} />
            </DrawerField>
            <DrawerField label="Company">
              <EditableCell value={contact.company} onSave={(v) => onPatch(contact.id, { company: v })} />
            </DrawerField>
            <DrawerField label="Email">
              <EditableCell value={contact.email} onSave={(v) => onPatch(contact.id, { email: v })} />
            </DrawerField>
            <DrawerField label="Phone">
              <EditableCell value={contact.phone} onSave={(v) => onPatch(contact.id, { phone: v })} />
            </DrawerField>
            <DrawerField label="LinkedIn">
              <EditableCell value={contact.linkedin} onSave={(v) => onPatch(contact.id, { linkedin: v })} />
            </DrawerField>
            <DrawerField label="Source">
              <EditableCell value={contact.source} onSave={(v) => onPatch(contact.id, { source: v })} />
            </DrawerField>
            <DrawerField label="Next step">
              <EditableCell value={contact.nextStep} onSave={(v) => onPatch(contact.id, { nextStep: v })} />
            </DrawerField>
            <DrawerField label="Last touch">
              <EditableCell value={contact.lastTouch} onSave={(v) => onPatch(contact.id, { lastTouch: v })} />
            </DrawerField>

            {/* User-defined columns live alongside the built-ins so editing
                one place keeps the board + drawer in sync. */}
            {customCols.map((c) => {
              const v = (contact.customFields ?? {})[c.id] ?? "";
              return (
                <DrawerField key={c.id} label={c.label}>
                  <EditableCell
                    value={v}
                    onSave={(next) => onPatch(contact.id, { customFields: { [c.id]: next } })}
                  />
                </DrawerField>
              );
            })}

            <DrawerField label="What to personalize" block>
              <textarea
                className="drawer-notes"
                defaultValue={contact.messageNotes ?? ""}
                placeholder="One-liner hook, recent post, mutual connection, what to lead with…"
                onBlur={(e) => {
                  const v = e.target.value;
                  if ((contact.messageNotes ?? "") !== v) onPatch(contact.id, { messageNotes: v });
                }}
              />
            </DrawerField>
            <DrawerField label="Notes" block>
              <textarea
                className="drawer-notes"
                defaultValue={contact.notes ?? ""}
                placeholder="Log a call, note, or what you learned…"
                onBlur={(e) => {
                  const v = e.target.value;
                  if ((contact.notes ?? "") !== v) onPatch(contact.id, { notes: v });
                }}
              />
            </DrawerField>
          </div>
        </div>
        <div className="drawer-foot">
          {onDelete && (
            <button
              className="pill-btn"
              style={{ color: "var(--danger, oklch(0.55 0.2 25))" }}
              title="Delete contact"
              onClick={async () => {
                const ok = await modal.confirm({
                  title: `Delete "${contact.name}"?`,
                  message: "Remove this contact from the board.",
                  confirmLabel: "Delete",
                  destructive: true,
                });
                if (ok) { onDelete(contact.id); onClose(); }
              }}
            >
              <IconClose size={13} />Delete
            </button>
          )}
          <button className="pill-btn" style={{ flex: 1 }} onClick={advanceStage}>
            Move to next stage <IconArrowR size={13} />
          </button>
        </div>
      </div>
    </>
  );
}

// ========== CRMView — top-level ==========

export function CRMView({
  viewMode, setViewMode, onFlash,
  activeBoardId, onActiveBoardChange, onBoardsChange,
}: {
  viewMode: "kanban" | "table";
  setViewMode: (v: "kanban" | "table") => void;
  onFlash: (msg: string) => void;
  /** Optional controlled active board — when provided, changes bubble up via onActiveBoardChange. */
  activeBoardId?: string;
  onActiveBoardChange?: (id: string) => void;
  /** Fires whenever the boards list changes so the sidebar can stay in sync. */
  onBoardsChange?: (boards: CrmBoard[]) => void;
}) {
  const modal = useModal();
  const [boards, setBoards] = useState<CrmBoard[]>([]);
  const [internalActiveId, setInternalActiveId] = useState<string>("");
  const activeId = activeBoardId ?? internalActiveId;
  const setActiveId = (id: string) => {
    if (onActiveBoardChange) onActiveBoardChange(id);
    setInternalActiveId(id);
  };
  const [contacts, setContacts] = useState<CrmContact[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [openContact, setOpenContact] = useState<CrmContact | null>(null);
  const [loading, setLoading] = useState(true);
  const [enriching, setEnriching] = useState(false);
  const [visibleCols, setVisibleCols] = useState<string[]>(BUILTIN_COL_IDS);
  const [customCols, setCustomCols] = useState<CustomColumn[]>([]);

  // Load boards + auto-select the first one.
  useEffect(() => {
    api.get<{ boards: CrmBoard[] }>("/api/crm/boards")
      .then((r) => {
        setBoards(r.boards);
        onBoardsChange?.(r.boards);
        if (!activeId && r.boards[0]) setActiveId(r.boards[0].id);
      })
      .catch((e) => onFlash(`Load boards failed: ${e.message}`))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onFlash]);

  // Whenever the active board changes, pull its saved column config.
  useEffect(() => {
    if (!activeId) return;
    const cc = loadCustomCols(activeId);
    setCustomCols(cc);
    setVisibleCols(loadColsConfig(activeId, cc.map((c) => c.id)));
  }, [activeId]);

  // Load contacts when active board changes.
  useEffect(() => {
    if (!activeId) return;
    api.get<{ contacts: CrmContact[] }>(`/api/crm/boards/${activeId}/contacts`)
      .then((r) => setContacts(r.contacts))
      .catch((e) => onFlash(`Load contacts failed: ${e.message}`));
  }, [activeId, onFlash]);

  const active = boards.find((b) => b.id === activeId);

  const patchContact = async (id: string, patch: Partial<CrmContact>) => {
    // Optimistic update — merge customFields instead of replacing so patching
    // a single key doesn't wipe the rest of the bag on screen.
    setContacts((cs) => cs.map((c) => {
      if (c.id !== id) return c;
      const merged: CrmContact = { ...c, ...patch };
      if (patch.customFields) {
        merged.customFields = { ...(c.customFields ?? {}), ...patch.customFields };
      }
      return merged;
    }));
    try {
      const updated = await api.patch<CrmContact>(`/api/crm/contacts/${id}`, patch);
      setContacts((cs) => cs.map((c) => (c.id === id ? updated : c)));
    } catch (e) {
      onFlash(`Save failed: ${(e as Error).message}`);
    }
  };

  const addBoard = async () => {
    const name = await modal.prompt({
      title: "New CRM board",
      label: "Board name",
      defaultValue: "Untitled pipeline",
      confirmLabel: "Create board",
    });
    if (!name) return;
    const emojis = ["📣", "🎯", "🧲", "💼", "🌱", "🚀", "🔥", "📊", "✨", "🧭"];
    const emoji = emojis[boards.length % emojis.length];
    try {
      const b = await api.post<CrmBoard>("/api/crm/boards", { name, emoji });
      setBoards((bs) => { const next = [...bs, { ...b, contactCount: 0 }]; onBoardsChange?.(next); return next; });
      setActiveId(b.id);
      setContacts([]);
      onFlash(`Created "${name}"`);
    } catch (e) {
      onFlash(`Create board failed: ${(e as Error).message}`);
    }
  };

  const deleteBoard = async (id: string) => {
    const ok = await modal.confirm({
      title: "Delete this board?",
      message: "All contacts on it will be removed. This can't be undone.",
      confirmLabel: "Delete board",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/crm/boards/${id}`);
      const next = boards.filter((b) => b.id !== id);
      setBoards(next);
      onBoardsChange?.(next);
      setActiveId(next[0]!.id);
      onFlash("Board deleted");
    } catch (e) {
      onFlash(`Delete failed: ${(e as Error).message}`);
    }
  };

  const doImport = async (rows: CrmImportRow[], opts: ImportOptions) => {
    try {
      // 1. Figure out which board we're importing into.
      let boardId = activeId;
      let createdBoard: CrmBoard | null = null;
      if (opts.destination === "new") {
        createdBoard = await api.post<CrmBoard>("/api/crm/boards", {
          name: opts.newBoardName,
          emoji: opts.newBoardEmoji,
        });
        boardId = createdBoard.id;
      }
      if (!boardId) return;

      // 2. Bulk insert.
      await api.post(`/api/crm/boards/${boardId}/contacts/bulk`, {
        contacts: rows.map((r) => ({
          name: r.name,
          title: r.title ?? null,
          company: r.company ?? null,
          email: r.email ?? null,
          phone: r.phone ?? null,
          linkedin: r.linkedin ?? null,
          notes: r.notes ?? null,
          stage: (r.stage && ["new", "contacted", "replied", "meeting", "closed"].includes(r.stage)) ? r.stage : "new",
          temp: (r.temp && ["hot", "warm", "cold"].includes(r.temp)) ? r.temp : "warm",
          source: r.source ?? (opts.destination === "new" ? "Table import" : "CSV import"),
          nextStep: r.nextStep ?? "First touch",
        })),
      });

      // 3. Optional: auto-enrich via Apollo.
      let enrichSummary = "";
      if (opts.autoEnrich) {
        try {
          const er = await api.post<{ enriched: number; skipped: number; total: number }>(
            `/api/crm/boards/${boardId}/enrich`,
          );
          enrichSummary = ` · enriched ${er.enriched}/${er.total}`;
        } catch (err) {
          const m = (err as Error).message;
          enrichSummary = m.includes("apollo_not_configured")
            ? " · enrichment skipped (APOLLO_API_KEY not set)"
            : ` · enrich failed: ${m}`;
        }
      }

      // 4. Reload state and switch to the new board when applicable.
      const [cs, bs] = await Promise.all([
        api.get<{ contacts: CrmContact[] }>(`/api/crm/boards/${boardId}/contacts`),
        api.get<{ boards: CrmBoard[] }>("/api/crm/boards"),
      ]);
      setBoards(bs.boards);
      if (createdBoard) setActiveId(createdBoard.id);
      setContacts(cs.contacts);
      const label = createdBoard ? `"${createdBoard.name}"` : "this board";
      onFlash(`Imported ${rows.length} contact${rows.length === 1 ? "" : "s"} into ${label}${enrichSummary}`);
    } catch (e) {
      onFlash(`Import failed: ${(e as Error).message}`);
    }
  };

  const deleteContact = async (id: string) => {
    const target = contacts.find((c) => c.id === id);
    setContacts((cs) => cs.filter((c) => c.id !== id));
    setBoards((bs) => bs.map((b) => b.id === activeId ? { ...b, contactCount: Math.max(0, (b.contactCount ?? 1) - 1) } : b));
    try {
      await api.del(`/api/crm/contacts/${id}`);
      onFlash(`Deleted ${target?.name ?? "contact"}`);
    } catch (e) {
      onFlash(`Delete failed: ${(e as Error).message}`);
    }
  };

  const addContact = async (draft: { name: string; title?: string; company?: string; email?: string }) => {
    if (!activeId) return;
    try {
      const c = await api.post<CrmContact>(`/api/crm/boards/${activeId}/contacts`, {
        name: draft.name,
        title: draft.title || null,
        company: draft.company || null,
        email: draft.email || null,
      });
      setContacts((cs) => [...cs, c]);
      setBoards((bs) => bs.map((b) => b.id === activeId ? { ...b, contactCount: (b.contactCount ?? 0) + 1 } : b));
      onFlash(`Added ${c.name}`);
    } catch (e) {
      onFlash(`Add contact failed: ${(e as Error).message}`);
    }
  };

  const enrichAll = async () => {
    if (!activeId || enriching) return;
    const needEmail = contacts.filter((c) => !c.email || !c.email.trim()).length;
    if (contacts.length === 0) { onFlash("No contacts on this board yet."); return; }
    if (needEmail === 0) { onFlash("Every contact already has an email — nothing to enrich."); return; }
    setEnriching(true);
    try {
      const r = await api.post<{ enriched: number; skipped: number; alreadyHad?: number; total: number }>(
        `/api/crm/boards/${activeId}/enrich`,
      );
      const fresh = await api.get<{ contacts: CrmContact[] }>(`/api/crm/boards/${activeId}/contacts`);
      setContacts(fresh.contacts);
      const had = r.alreadyHad ?? 0;
      onFlash(
        `Got email for ${r.enriched}` +
        (r.skipped ? ` · ${r.skipped} no match` : "") +
        (had ? ` · ${had} already had one` : ""),
      );
    } catch (e) {
      onFlash(`Get email failed: ${(e as Error).message}`);
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
          {viewMode === "table" && (
            <ColumnsMenu
              boardId={activeId}
              value={visibleCols}
              onChange={setVisibleCols}
              customCols={customCols}
              onCustomColsChange={setCustomCols}
            />
          )}
          <button className="pill-btn" disabled={enriching} onClick={enrichAll} title="Fill email for contacts that don't have one yet (via Apollo.io)">
            <IconMail size={12} />{enriching ? "Getting email…" : "Get email"}
          </button>
          <button className="pill-btn" onClick={() => setImportOpen(true)}>
            <IconUpload size={12} />Import CSV
          </button>
          <button className="pill-btn primary" onClick={() => setAddOpen(true)}>
            <IconNewChat size={12} />Add contact
          </button>
        </div>
      </div>

      {viewMode === "kanban" ? (
        <KanbanBoard
          contacts={contacts}
          onOpen={setOpenContact}
          onMoveStage={(id, stage) => patchContact(id, { stage })}
          onDelete={deleteContact}
        />
      ) : (
        <TableView
          contacts={contacts}
          onOpen={setOpenContact}
          onPatch={patchContact}
          columns={visibleCols}
          customCols={customCols}
        />
      )}

      {importOpen && (
        <ImportModal
          boardName={active.name}
          onClose={() => setImportOpen(false)}
          onImport={doImport}
        />
      )}

      {addOpen && (
        <AddContactModal
          boardName={active.name}
          onClose={() => setAddOpen(false)}
          onAdd={async (d) => { await addContact(d); setAddOpen(false); }}
        />
      )}

      {openContact && (
        <CRMDrawer
          contact={openContact}
          idx={contacts.findIndex((c) => c.id === openContact.id)}
          onClose={() => setOpenContact(null)}
          customCols={customCols}
          onPatch={(id, patch) => {
            patchContact(id, patch);
            setOpenContact((c) => {
              if (!c || c.id !== id) return c;
              const merged: CrmContact = { ...c, ...patch };
              if (patch.customFields) {
                merged.customFields = { ...(c.customFields ?? {}), ...patch.customFields };
              }
              return merged;
            });
          }}
          onDelete={deleteContact}
        />
      )}
    </div>
  );
}

