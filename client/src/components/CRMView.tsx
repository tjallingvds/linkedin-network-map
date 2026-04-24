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
  IconSend, IconMail, IconSparkle, IconLinkedIn, IconUsers,
} from "../design/icons";
import { ExternalCleanupModal } from "./ExternalCleanupModal";

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
  { id: "linkedin", label: "LinkedIn",   width: "1.2fr" },
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
function kanbanFieldsKey(boardId: string) { return `crm.kanbanfields.v1.${boardId}`; }

/** Fields the user can opt into showing on each kanban card. Order matters. */
const KANBAN_FIELD_OPTIONS = [
  { id: "title",        label: "Title" },
  { id: "company",      label: "Company" },
  { id: "email",        label: "Email" },
  { id: "phone",        label: "Phone" },
  { id: "linkedin",     label: "LinkedIn" },
  { id: "temp",         label: "Temp" },
  { id: "nextStep",     label: "Next step" },
  { id: "source",       label: "Source" },
  { id: "messageNotes", label: "Personalize" },
  { id: "notes",        label: "Notes" },
] as const;
const KANBAN_DEFAULT = ["title", "company"];

function loadKanbanFields(boardId: string, customColIds: string[]): string[] {
  const allIds = [...KANBAN_FIELD_OPTIONS.map((f) => f.id), ...customColIds];
  if (!boardId) return KANBAN_DEFAULT;
  try {
    const raw = localStorage.getItem(kanbanFieldsKey(boardId));
    if (!raw) return KANBAN_DEFAULT;
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return KANBAN_DEFAULT;
    return (arr as string[]).filter((id) => allIds.includes(id));
  } catch { return KANBAN_DEFAULT; }
}
function saveKanbanFields(boardId: string, ids: string[]) {
  if (!boardId) return;
  try { localStorage.setItem(kanbanFieldsKey(boardId), JSON.stringify(ids)); } catch { /* noop */ }
}

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

/** Columns added to the built-in set AFTER the first release of this
 *  feature. Existing users have a saved config that predates these, so
 *  we auto-add them on load. Once the user toggles a new column off, it
 *  gets written into the saved array and stays off from then on. */
const AUTO_ADD_NEW_BUILTINS = ["linkedin"];

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
    // Migrate: append any AUTO_ADD_NEW_BUILTINS the saved config doesn't
    // know about. Prevents existing boards from hiding freshly-shipped
    // columns just because their config was written before the column
    // existed.
    const migrated = AUTO_ADD_NEW_BUILTINS.filter((id) => !valid.includes(id));
    return [...required, ...valid, ...migrated];
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

// --- Stage definitions ---
// Stages are now user-editable per board — the defaults below seed new
// boards, but the ColumnsMenu ▸ Stages editor lets users add, rename,
// recolor, and remove them. The config lives in localStorage keyed by
// board id; the server accepts any stage string.
export interface StageDef { id: string; label: string; color: string; tint: string; }
const STAGE_PALETTE: { color: string; tint: string }[] = [
  { color: "oklch(0.72 0.04 280)", tint: "oklch(0.95 0.02 280 / 0.7)" },
  { color: "oklch(0.7 0.10 240)",  tint: "oklch(0.94 0.05 240 / 0.7)" },
  { color: "oklch(0.7 0.14 65)",   tint: "oklch(0.95 0.06 65 / 0.7)"  },
  { color: "oklch(0.65 0.16 165)", tint: "oklch(0.94 0.07 165 / 0.7)" },
  { color: "oklch(0.6 0.14 155)",  tint: "oklch(0.93 0.07 155 / 0.7)" },
  { color: "oklch(0.62 0.16 25)",  tint: "oklch(0.95 0.06 25 / 0.7)"  },
  { color: "oklch(0.62 0.14 300)", tint: "oklch(0.95 0.06 300 / 0.7)" },
  { color: "oklch(0.65 0.14 110)", tint: "oklch(0.95 0.06 110 / 0.7)" },
];
const DEFAULT_STAGES: StageDef[] = [
  { id: "new",       label: "New",       ...STAGE_PALETTE[0]! },
  { id: "contacted", label: "Contacted", ...STAGE_PALETTE[1]! },
  { id: "replied",   label: "Replied",   ...STAGE_PALETTE[2]! },
  { id: "meeting",   label: "Meeting",   ...STAGE_PALETTE[3]! },
  { id: "closed",    label: "Closed",    ...STAGE_PALETTE[4]! },
];
// Back-compat alias — older code paths referenced STAGES.
const STAGES = DEFAULT_STAGES;

function stagesKey(boardId: string) { return `crm.stages.v1.${boardId}`; }
function loadStages(boardId: string): StageDef[] {
  if (!boardId) return DEFAULT_STAGES;
  try {
    const raw = localStorage.getItem(stagesKey(boardId));
    if (!raw) return DEFAULT_STAGES;
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr) || arr.length === 0) return DEFAULT_STAGES;
    return (arr as StageDef[]).filter((s) => s && typeof s.id === "string" && typeof s.label === "string");
  } catch { return DEFAULT_STAGES; }
}
function saveStages(boardId: string, stages: StageDef[]) {
  if (!boardId) return;
  try { localStorage.setItem(stagesKey(boardId), JSON.stringify(stages)); } catch { /* noop */ }
}
function makeStageId(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32) || "stage";
  return `${slug}_${Math.random().toString(36).slice(2, 6)}`;
}

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
  p, idx, onOpen, onDelete, onDragStart, onDragEnd, dragging, fields, customCols,
}: {
  p: CrmContact;
  idx: number;
  onOpen: (c: CrmContact) => void;
  onDelete: (id: string) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  dragging: boolean;
  /** Ordered field ids the user wants shown on the card. "name" is implicit. */
  fields: string[];
  customCols: CustomColumn[];
}) {
  const modal = useModal();
  const customById = Object.fromEntries(customCols.map((c) => [c.id, c]));

  const renderField = (id: string): React.ReactNode => {
    const customLabel = customById[id]?.label;
    const raw: string | null | undefined =
      id === "title" ? p.title :
      id === "company" ? p.company :
      id === "email" ? p.email :
      id === "phone" ? p.phone :
      id === "linkedin" ? p.linkedin :
      id === "temp" ? p.temp :
      id === "nextStep" ? p.nextStep :
      id === "source" ? p.source :
      id === "messageNotes" ? p.messageNotes ?? null :
      id === "notes" ? p.notes :
      customLabel ? (p.customFields ?? {})[id] ?? null :
      null;
    if (!raw) return null;
    return (
      <div key={id} className="kc-field">
        {customLabel && <span className="kc-field-label">{customLabel}:</span>}
        <span className="kc-field-value">{raw}</span>
      </div>
    );
  };

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
          {fields.map(renderField)}
        </div>
      </div>
    </div>
  );
}

/** Dropdown menu that toggles which fields show on kanban cards (per board,
 *  persisted to localStorage, same pattern as ColumnsMenu). */
function KanbanFieldsMenu({
  boardId, value, onChange, customCols,
}: {
  boardId: string;
  value: string[];
  onChange: (next: string[]) => void;
  customCols: CustomColumn[];
}) {
  const [open, setOpen] = useState(false);
  const toggle = (id: string) => {
    const next = value.includes(id) ? value.filter((x) => x !== id) : [...value, id];
    onChange(next);
    saveKanbanFields(boardId, next);
  };
  const reset = () => {
    onChange(KANBAN_DEFAULT);
    saveKanbanFields(boardId, KANBAN_DEFAULT);
  };
  return (
    <div style={{ position: "relative" }}>
      <button className="pill-btn" title="Show/hide fields on kanban cards" onClick={() => setOpen((o) => !o)}>
        <IconSheet size={12} />Card fields
      </button>
      {open && (
        <>
          <div className="board-menu-bg" onClick={() => setOpen(false)} />
          <div className="board-menu" style={{ minWidth: 220, right: 0, left: "auto" }}>
            <div className="bm-label">Built-in</div>
            {KANBAN_FIELD_OPTIONS.map((f) => {
              const on = value.includes(f.id);
              return (
                <button key={f.id} className="bm-item" onClick={() => toggle(f.id)}>
                  <ColCheckbox on={on} />
                  <span style={{ flex: 1, textAlign: "left" }}>{f.label}</span>
                </button>
              );
            })}
            {customCols.length > 0 && <>
              <div className="bm-sep" />
              <div className="bm-label">Your columns</div>
              {customCols.map((c) => {
                const on = value.includes(c.id);
                return (
                  <button key={c.id} className="bm-item" onClick={() => toggle(c.id)}>
                    <ColCheckbox on={on} />
                    <span style={{ flex: 1, textAlign: "left" }}>{c.label}</span>
                  </button>
                );
              })}
            </>}
            <div className="bm-sep" />
            <button className="bm-item" onClick={reset}>
              <IconArrowR size={13} /><span>Reset to defaults</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function KanbanBoard({
  contacts, onOpen, onMoveStage, onDelete, fields, customCols, stages,
}: {
  contacts: CrmContact[];
  onOpen: (c: CrmContact) => void;
  onMoveStage: (contactId: string, stage: CrmStage) => void;
  onDelete: (id: string) => void;
  fields: string[];
  customCols: CustomColumn[];
  stages: StageDef[];
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);
  const list = stages.length > 0 ? stages : DEFAULT_STAGES;
  // Collect contacts whose stage id isn't in the current stage config so we
  // can still render them in an "Other" column rather than losing track.
  const validIds = new Set(list.map((s) => s.id));
  const orphan = contacts.filter((c) => !validIds.has(c.stage));

  return (
    <div className="kanban">
      {list.map((stage) => {
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
                if (src && src.stage !== stage.id) onMoveStage(id, stage.id as CrmStage);
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
                  fields={fields}
                  customCols={customCols}
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
      {orphan.length > 0 && (
        <div
          className="kanban-col"
          style={{ "--stage-tint": "oklch(0.96 0 0 / 0.7)", "--stage-color": "oklch(0.7 0 0)" } as React.CSSProperties}
        >
          <div className="kanban-head">
            <span className="kanban-bar" />
            <span className="kanban-title">Other</span>
            <span className="kanban-count">{orphan.length}</span>
          </div>
          <div className="kanban-list">
            {orphan.map((p) => (
              <KanbanCard
                key={p.id}
                p={p}
                idx={contacts.indexOf(p)}
                onOpen={onOpen}
                onDelete={onDelete}
                onDragStart={(id) => setDraggingId(id)}
                onDragEnd={() => { setDraggingId(null); setOverStage(null); }}
                dragging={draggingId === p.id}
                fields={fields}
                customCols={customCols}
              />
            ))}
          </div>
        </div>
      )}
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

/** LinkedIn cell — renders the URL as a clickable link when not editing,
 *  double-click to switch to an input. Keeps the cell inline (no extra
 *  icon button column) so the table stays dense. */
function LinkedInCell({
  value, onSave,
}: { value: string | null | undefined; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value ?? "");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  useEffect(() => { setV(value ?? ""); }, [value]);
  const commit = () => { setEditing(false); if (v !== (value ?? "")) onSave(v); };
  if (editing) {
    return (
      <input
        ref={ref}
        className="ed-input"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") { setV(value ?? ""); setEditing(false); }
        }}
        onClick={(e) => e.stopPropagation()}
        placeholder="linkedin.com/in/..."
      />
    );
  }
  if (!value) {
    return (
      <span
        className="ed-cell"
        onClick={(e) => { e.stopPropagation(); setEditing(true); }}
        style={{ width: "100%", color: "var(--text-mute)" }}
      >
        <em>—</em>
      </span>
    );
  }
  // Shorten for display: strip protocol + trailing slash so the cell
  // shows "linkedin.com/in/username" rather than a full https URL.
  const display = value.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
  return (
    <span
      className="ed-cell"
      onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
      onClick={(e) => e.stopPropagation()}
      style={{ width: "100%", display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}
      title="Double-click to edit"
    >
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          color: "var(--accent)",
          textDecoration: "none",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
        }}
      >
        {display}
      </a>
    </span>
  );
}

function StageCell({
  stage, stages = DEFAULT_STAGES, onChange,
}: {
  stage: CrmStage;
  stages?: StageDef[];
  onChange: (s: CrmStage) => void;
}) {
  const [open, setOpen] = useState(false);
  const list = stages.length > 0 ? stages : DEFAULT_STAGES;
  // Fall back gracefully if the contact's stored stage doesn't exist in the
  // current stages config (e.g. after deleting a stage).
  const s = list.find((x) => x.id === stage) ?? { id: stage, label: stage || "—", color: "oklch(0.7 0 0)", tint: "oklch(0.95 0 0 / 0.7)" };
  return (
    <div className="stage-cell" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
      <span className="tbl-stage" style={{ "--stage-color": s.color, "--stage-tint": s.tint } as React.CSSProperties}>
        {s.label}
      </span>
      {open && (
        <div className="stage-menu" onMouseLeave={() => setOpen(false)}>
          {list.map((st) => (
            <button key={st.id} onClick={(e) => { e.stopPropagation(); onChange(st.id as CrmStage); setOpen(false); }}>
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
  contacts, onOpen, onPatch, columns, customCols, stages,
}: {
  contacts: CrmContact[];
  onOpen: (c: CrmContact) => void;
  onPatch: (id: string, patch: Partial<CrmContact>) => void;
  /** Ordered list of visible column ids. */
  columns: string[];
  customCols: CustomColumn[];
  stages: StageDef[];
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
      case "linkedin": return (
        <LinkedInCell
          value={p.linkedin}
          onSave={(v) => onPatch(p.id, { linkedin: normalizeLinkedInInput(v) ?? v })}
        />
      );
      case "stage":   return <StageCell stage={p.stage} stages={stages} onChange={(v) => onPatch(p.id, { stage: v })} />;
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

function BoardShareMenu({
  boardId, boardName, owned, onFlash,
}: {
  boardId: string;
  boardName: string;
  owned: boolean;
  onFlash: (msg: string) => void;
}) {
  const modal = useModal();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const copy = async (t: string) => {
    try {
      await navigator.clipboard.writeText(t);
      onFlash("Share code copied");
    } catch {
      onFlash(`Share code: ${t}`);
    }
  };

  const generate = async () => {
    setLoading(true);
    try {
      const r = await api.post<{ token: string }>(`/api/crm/boards/${boardId}/share`);
      setToken(r.token);
      copy(r.token);
    } catch (e) {
      onFlash(`Share failed: ${(e as Error).message}`);
    } finally { setLoading(false); }
  };

  const revoke = async () => {
    const ok = await modal.confirm({
      title: "Revoke share code?",
      message: "Anyone holding the old code loses access. Current members are removed.",
      confirmLabel: "Revoke",
      destructive: true,
    });
    if (!ok) return;
    setLoading(true);
    try {
      await api.del(`/api/crm/boards/${boardId}/share`);
      setToken(null);
      onFlash("Share revoked");
    } catch (e) {
      onFlash(`Revoke failed: ${(e as Error).message}`);
    } finally { setLoading(false); }
  };

  if (!owned) {
    return (
      <span className="pill-btn" style={{ color: "var(--text-mute)", cursor: "default" }} title="Shared by someone else">
        <IconUsers size={12} />Shared with you
      </span>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <button className="pill-btn" onClick={() => setOpen((o) => !o)} title="Share this board with a collaborator">
        <IconUsers size={12} />Share
      </button>
      {open && (
        <>
          <div className="board-menu-bg" onClick={() => setOpen(false)} />
          <div className="board-menu" style={{ minWidth: 260, right: 0, left: "auto", padding: 12 }}>
            <div className="bm-label" style={{ padding: 0, marginBottom: 8 }}>Share "{boardName}"</div>
            {token ? (
              <>
                <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 8 }}>
                  Send this code to a teammate. They paste it in Settings → Join a shared board.
                </div>
                <div
                  style={{
                    display: "flex", gap: 6, alignItems: "center",
                    padding: "8px 10px", background: "var(--panel)", border: "1px solid var(--hairline)",
                    borderRadius: 8, fontFamily: "Geist Mono, monospace", fontSize: 14, letterSpacing: "0.15em",
                    color: "var(--text)", fontWeight: 600,
                  }}
                >
                  <span style={{ flex: 1 }}>{token}</span>
                  <button className="pill-btn" onClick={() => copy(token)} style={{ fontSize: 11 }}>Copy</button>
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                  <button className="pill-btn" onClick={revoke} disabled={loading} style={{ color: "var(--danger, oklch(0.55 0.2 25))" }}>
                    <IconClose size={12} />Revoke
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 10 }}>
                  Generate a short code. Share it — anyone with it can read + edit this board.
                </div>
                <button className="pill-btn primary" onClick={generate} disabled={loading} style={{ width: "100%" }}>
                  <IconCheck size={12} />{loading ? "Generating…" : "Generate share code"}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Per-board stage editor. Add, rename, recolor, reorder (delete moves the
 *  contacts on that stage to the next remaining stage). Persisted to
 *  localStorage. Server accepts any stage string. */
function StagesMenu({
  boardId, value, onChange, onReassign,
}: {
  boardId: string;
  value: StageDef[];
  onChange: (next: StageDef[]) => void;
  /** Called when a stage is deleted so callers can move the contacts on it. */
  onReassign: (fromId: string, toId: string) => void;
}) {
  const modal = useModal();
  const [open, setOpen] = useState(false);
  const persist = (next: StageDef[]) => { onChange(next); saveStages(boardId, next); };

  const addStage = async () => {
    const label = await modal.prompt({
      title: "New stage", label: "Stage name",
      placeholder: "e.g. Qualified", confirmLabel: "Add stage",
    });
    if (!label) return;
    const palette = STAGE_PALETTE[value.length % STAGE_PALETTE.length]!;
    persist([...value, { id: makeStageId(label), label, ...palette }]);
  };
  const renameStage = async (id: string) => {
    const existing = value.find((s) => s.id === id);
    if (!existing) return;
    const label = await modal.prompt({
      title: "Rename stage", label: "New name",
      defaultValue: existing.label, confirmLabel: "Rename",
    });
    if (!label) return;
    persist(value.map((s) => (s.id === id ? { ...s, label } : s)));
  };
  const recolorStage = (id: string, paletteIdx: number) => {
    const c = STAGE_PALETTE[paletteIdx]!;
    persist(value.map((s) => (s.id === id ? { ...s, color: c.color, tint: c.tint } : s)));
  };
  const removeStage = async (id: string) => {
    if (value.length <= 1) return;
    const target = value.find((s) => s.id === id);
    if (!target) return;
    const fallback = value.find((s) => s.id !== id)!;
    const ok = await modal.confirm({
      title: `Delete "${target.label}"?`,
      message: `Any contacts in this stage will move to "${fallback.label}".`,
      confirmLabel: "Delete stage",
      destructive: true,
    });
    if (!ok) return;
    persist(value.filter((s) => s.id !== id));
    onReassign(id, fallback.id);
  };
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= value.length) return;
    const next = value.slice();
    [next[idx], next[j]] = [next[j]!, next[idx]!];
    persist(next);
  };

  return (
    <div style={{ position: "relative" }}>
      <button className="pill-btn" title="Edit pipeline stages" onClick={() => setOpen((o) => !o)}>
        <IconList size={12} />Stages
      </button>
      {open && (
        <>
          <div className="board-menu-bg" onClick={() => setOpen(false)} />
          <div className="board-menu" style={{ minWidth: 300, right: 0, left: "auto", maxHeight: "70vh", overflowY: "auto" }}>
            <div className="bm-label">Pipeline stages</div>
            {value.map((s, i) => (
              <div key={s.id} className="bm-item" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.color, flexShrink: 0 }} />
                <span style={{ flex: 1, textAlign: "left", color: "var(--text)", fontWeight: 500 }}>{s.label}</span>
                <button
                  title="Move up"
                  disabled={i === 0}
                  onClick={(e) => { e.stopPropagation(); move(i, -1); }}
                  style={{ fontSize: 10.5, color: i === 0 ? "var(--text-mute)" : "var(--text-dim)", padding: "2px 4px" }}
                >↑</button>
                <button
                  title="Move down"
                  disabled={i === value.length - 1}
                  onClick={(e) => { e.stopPropagation(); move(i, +1); }}
                  style={{ fontSize: 10.5, color: i === value.length - 1 ? "var(--text-mute)" : "var(--text-dim)", padding: "2px 4px" }}
                >↓</button>
                <button
                  title="Rename"
                  onClick={(e) => { e.stopPropagation(); renameStage(s.id); }}
                  style={{ fontSize: 10.5, color: "var(--text-mute)", padding: "2px 6px" }}
                >rename</button>
                <button
                  title="Cycle color"
                  onClick={(e) => { e.stopPropagation(); recolorStage(s.id, (i + 1) % STAGE_PALETTE.length); }}
                  style={{ fontSize: 10.5, color: "var(--text-mute)", padding: "2px 6px" }}
                >color</button>
                <button
                  title={value.length <= 1 ? "Keep at least one stage" : "Delete"}
                  disabled={value.length <= 1}
                  onClick={(e) => { e.stopPropagation(); removeStage(s.id); }}
                  style={{ fontSize: 10.5, color: value.length <= 1 ? "var(--text-mute)" : "var(--danger, oklch(0.55 0.2 25))", padding: "2px 6px" }}
                >delete</button>
              </div>
            ))}
            <div className="bm-sep" />
            <button className="bm-item" onClick={addStage}>
              <IconNewChat size={13} /><span>Add stage…</span>
            </button>
            <button className="bm-item" onClick={() => persist(DEFAULT_STAGES)}>
              <IconArrowR size={13} /><span>Reset to defaults</span>
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
                {destination === "new" ? <> to a new board <strong>{newBoardName.trim() || "Imported list"}</strong></> : <> to <strong>{boardName}</strong></>}.
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
  onAdd: (d: { name: string; title?: string; company?: string; email?: string; linkedin?: string }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [linkedin, setLinkedin] = useState("");
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
        linkedin: normalizeLinkedInInput(linkedin),
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
          <Field label="LinkedIn">
            <input value={linkedin} onChange={(e) => setLinkedin(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && canSave) submit(); }}
              placeholder="linkedin.com/in/maya-okafor" style={{ padding: "8px 10px", background: "var(--panel)", border: "1px solid var(--hairline)", borderRadius: 8, fontSize: 12.5, color: "var(--text)" }}/>
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

/** Accept whatever the user pastes — "linkedin.com/in/x", "www.linkedin.com/in/x",
 *  "/in/x", a full https URL, or a bare username ("mayaokafor") — and return a
 *  clean https://linkedin.com/in/… URL. Returns undefined for empty/unrecognised
 *  input so the backend field stays null instead of a broken string. */
function normalizeLinkedInInput(raw: string): string | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  if (/^https?:\/\//i.test(t)) return t.replace(/^http:\/\//i, "https://");
  if (/^(www\.)?linkedin\.com\//i.test(t)) return `https://${t.replace(/^www\./i, "")}`;
  if (/^\/?in\//i.test(t)) return `https://linkedin.com/${t.replace(/^\//, "")}`;
  // Bare username — build a profile URL.
  if (/^[a-z0-9][a-z0-9-]{2,}$/i.test(t)) return `https://linkedin.com/in/${t}`;
  // Unrecognised — keep what the user typed so they can edit it later.
  return t;
}

/** Minimal markdown renderer for the LLM-generated background blob —
 *  supports [label](url) inline links, `-`/`*` bullets, and newlines.
 *  Escapes HTML specials so we don't have to trust the LLM output. */
function renderBackgroundMarkdown(md: string): string {
  const esc = (s: string) => s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const lines = md.split(/\r?\n/).map((line) => {
    const bullet = /^\s*[-*]\s+/.test(line);
    const body = esc(line.replace(/^\s*[-*]\s+/, "")).replace(
      /\[([^\]]+)\]\((https?:[^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:var(--accent);text-decoration:underline">$1</a>',
    );
    return bullet ? `• ${body}` : body;
  });
  return lines.join("<br/>");
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
  contact, idx, onClose, onPatch, onDelete, customCols = [], stages = DEFAULT_STAGES,
}: {
  contact: CrmContact;
  idx: number;
  onClose: () => void;
  onPatch: (id: string, patch: Partial<CrmContact>) => void;
  onDelete?: (id: string) => void;
  /** User-defined board columns so the drawer shows the same fields as the table. */
  customCols?: CustomColumn[];
  stages?: StageDef[];
}) {
  const modal = useModal();
  const stageList = stages.length > 0 ? stages : DEFAULT_STAGES;
  const stage = stageList.find((s) => s.id === contact.stage) ?? stageList[0]!;

  const advanceStage = () => {
    const i = stageList.findIndex((s) => s.id === contact.stage);
    const next = stageList[Math.min(stageList.length - 1, i + 1)]!;
    onPatch(contact.id, { stage: next.id as CrmStage });
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
                <StageCell stage={contact.stage} stages={stageList} onChange={(v) => onPatch(contact.id, { stage: v })} />
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
            {contact.background && (
              <DrawerField label="Background (auto-researched)" block>
                <div
                  className="drawer-bg-block"
                  style={{
                    padding: "10px 12px",
                    borderRadius: 8,
                    background: "var(--panel)",
                    border: "1px solid var(--hairline)",
                    fontSize: 12.5,
                    lineHeight: 1.5,
                    color: "var(--text)",
                    whiteSpace: "pre-wrap",
                  }}
                  // Background is LLM-generated markdown with inline links.
                  // Render it minimally — linkify [label](url) and preserve
                  // bullets. Source: trusted backend, no user input.
                  dangerouslySetInnerHTML={{ __html: renderBackgroundMarkdown(contact.background) }}
                />
              </DrawerField>
            )}
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
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [openContact, setOpenContact] = useState<CrmContact | null>(null);
  const [loading, setLoading] = useState(true);
  const [enriching, setEnriching] = useState(false);
  const [backgrounding, setBackgrounding] = useState(false);
  const [visibleCols, setVisibleCols] = useState<string[]>(BUILTIN_COL_IDS);
  const [customCols, setCustomCols] = useState<CustomColumn[]>([]);
  const [kanbanFields, setKanbanFields] = useState<string[]>(KANBAN_DEFAULT);
  const [stages, setStages] = useState<StageDef[]>(DEFAULT_STAGES);

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

  // Whenever the active board changes, pull its saved column + kanban config.
  useEffect(() => {
    if (!activeId) return;
    const cc = loadCustomCols(activeId);
    setCustomCols(cc);
    setVisibleCols(loadColsConfig(activeId, cc.map((c) => c.id)));
    setKanbanFields(loadKanbanFields(activeId, cc.map((c) => c.id)));
    setStages(loadStages(activeId));
  }, [activeId]);

  // Load contacts when active board changes, then poll every 8s so shared
  // boards reflect what other collaborators are doing without a hard refresh.
  useEffect(() => {
    if (!activeId) return;
    let stopped = false;
    const load = () => {
      api.get<{ contacts: CrmContact[] }>(`/api/crm/boards/${activeId}/contacts`)
        .then((r) => { if (!stopped) setContacts(r.contacts); })
        .catch((e) => { if (!stopped) onFlash(`Load contacts failed: ${e.message}`); });
    };
    load();
    const iv = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 8_000);
    return () => { stopped = true; window.clearInterval(iv); };
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
    try {
      const b = await api.post<CrmBoard>("/api/crm/boards", { name });
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

  const addContact = async (draft: { name: string; title?: string; company?: string; email?: string; linkedin?: string }) => {
    if (!activeId) return;
    try {
      const c = await api.post<CrmContact>(`/api/crm/boards/${activeId}/contacts`, {
        name: draft.name,
        title: draft.title || null,
        company: draft.company || null,
        email: draft.email || null,
        linkedin: draft.linkedin || null,
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

  /** "Find backgrounds" — for every contact without a background, search
   *  the web and ask the LLM to pull 2-4 specific, cited facts (recent
   *  posts, talks, notable opinions). Stored in contact.background. */
  const findBackgrounds = async () => {
    if (!activeId || backgrounding) return;
    if (contacts.length === 0) { onFlash("No contacts on this board yet."); return; }
    const needBg = contacts.filter((c) => !c.background || !c.background.trim()).length;
    if (needBg === 0) { onFlash("Every contact already has a background — nothing to research."); return; }
    setBackgrounding(true);
    try {
      const r = await api.post<{ filled: number; skipped: number; alreadyHad?: number; total: number }>(
        `/api/crm/boards/${activeId}/background`,
      );
      const fresh = await api.get<{ contacts: CrmContact[] }>(`/api/crm/boards/${activeId}/contacts`);
      setContacts(fresh.contacts);
      const had = r.alreadyHad ?? 0;
      onFlash(
        `Researched ${r.filled}` +
        (r.skipped ? ` · ${r.skipped} no sources found` : "") +
        (had ? ` · ${had} already had one` : ""),
      );
    } catch (e) {
      onFlash(`Find backgrounds failed: ${(e as Error).message}`);
    } finally {
      setBackgrounding(false);
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
          {active && (
            <BoardShareMenu
              boardId={active.id}
              boardName={active.name}
              owned={active.owned !== false}
              onFlash={onFlash}
            />
          )}
          {viewMode === "table" ? (
            <ColumnsMenu
              boardId={activeId}
              value={visibleCols}
              onChange={setVisibleCols}
              customCols={customCols}
              onCustomColsChange={setCustomCols}
            />
          ) : (
            <KanbanFieldsMenu
              boardId={activeId}
              value={kanbanFields}
              onChange={setKanbanFields}
              customCols={customCols}
            />
          )}
          <StagesMenu
            boardId={activeId}
            value={stages}
            onChange={setStages}
            onReassign={async (fromId, toId) => {
              // Move every contact on the removed stage to the fallback.
              const affected = contacts.filter((c) => c.stage === fromId);
              setContacts((cs) => cs.map((c) => c.stage === fromId ? { ...c, stage: toId as CrmStage } : c));
              await Promise.all(affected.map((c) =>
                api.patch(`/api/crm/contacts/${c.id}`, { stage: toId }).catch(() => { /* non-fatal */ }),
              ));
            }}
          />
          <button className="pill-btn" disabled={enriching} onClick={enrichAll} title="Fill email for contacts that don't have one yet (via Apollo.io)">
            <IconMail size={12} />{enriching ? "Getting email…" : "Get email"}
          </button>
          <button
            className="pill-btn"
            disabled={backgrounding}
            onClick={findBackgrounds}
            title="Research each contact on the web — posts, talks, notable things they've said — with inline source links"
          >
            <IconSparkle size={12} />{backgrounding ? "Researching…" : "Find backgrounds"}
          </button>
          <button className="pill-btn" onClick={() => setImportOpen(true)}>
            <IconUpload size={12} />Import CSV
          </button>
          <button
            className="pill-btn"
            onClick={() => setCleanupOpen(true)}
            title="Upload a CSV from another CRM — any matching contacts will be removed from all your boards so you don't double-touch them"
          >
            <IconClose size={12} />Remove from external CRM
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
          fields={kanbanFields}
          customCols={customCols}
          stages={stages}
        />
      ) : (
        <TableView
          contacts={contacts}
          onOpen={setOpenContact}
          onPatch={patchContact}
          columns={visibleCols}
          customCols={customCols}
          stages={stages}
        />
      )}

      {importOpen && (
        <ImportModal
          boardName={active.name}
          onClose={() => setImportOpen(false)}
          onImport={doImport}
        />
      )}

      {cleanupOpen && (
        <ExternalCleanupModal
          onClose={() => setCleanupOpen(false)}
          onFlash={onFlash}
          onDone={async () => {
            // Refresh the active board — the dedup sweep and any deletes need
            // to be reflected in the UI without a hard reload.
            if (!activeId) return;
            try {
              const r = await api.get<{ contacts: CrmContact[] }>(`/api/crm/boards/${activeId}/contacts`);
              setContacts(r.contacts);
            } catch { /* non-fatal — next interaction will refetch */ }
          }}
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
          stages={stages}
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

