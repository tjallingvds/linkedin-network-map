/**
 * CRM — multi-board pipeline (kanban + editable table), backed by the real
 * backend (`/api/crm/boards`, `/api/crm/boards/:id/contacts`, etc).
 *
 * Ported from design/project/CRMView.jsx. Board + contact state is persisted
 * server-side; the React tree just reflects it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CrmBoard, CrmContact, CrmImportRow, CrmStage, CrmTemp,
  CrmColumnDef, CrmColumnType, CrmRowHeight, CrmDropdownOption,
} from "@app/shared";
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
 * The CRM table is driven by a single per-board column schema (`CrmColumnDef[]`)
 * stored on the board itself, not in localStorage. That way collaborators see
 * each other's columns, renames, and reorders in real time. Built-in columns
 * (`builtin: true`) back real contact fields (name/title/email/...). User-
 * added columns (`builtin: false`) store their values in `contact.customFields[id]`.
 *
 * Built-in columns can be renamed and hidden but not deleted or retyped — the
 * underlying DB column stays. Custom columns can be renamed, retyped, deleted,
 * and re-ordered freely.
 */
export type TableColumnDef = CrmColumnDef & { alwaysVisible?: boolean; numeric?: boolean };

/** Only Person (the avatar+name anchor) is required on the table.
 *  Everything else — including Stage, which the kanban gets from the
 *  board's `stages` JSONB independently — is the user's call. */
const REQUIRED_COLS: readonly string[] = ["person"];

/** Minimal seed for a fresh board — just the row checkbox, the Person
 *  column (name + avatar; can't be removed), and the Stage column (drives
 *  the kanban). Every other column on the board is something the user
 *  adds explicitly from the "+" menu. The underlying DB still has fields
 *  for email/phone/linkedin/title/company/etc. — Apollo enrichment, CSV
 *  import, and the contact drawer all still use them — but they don't
 *  pollute the table by default. */
function defaultColumns(): CrmColumnDef[] {
  return [
    // Fixed-pixel default widths — using fr units made Person bloat to fill
    // the entire table whenever there were only a few columns, shoving
    // Stage far to the right and making them look unrelated.
    { id: "person", builtin: true, label: "Person", width: "240px", type: "person" },
    { id: "stage",  builtin: true, label: "Stage",  width: "140px", type: "stage" },
  ];
}

/** Numeric columns get monospace + center-align by default. */
const NUMERIC_TYPES: readonly CrmColumnType[] = ["number"];

/** Backward-compat shape for components that still consume `CustomColumn[]`
 *  (KanbanCard, KanbanFieldsMenu, CRMDrawer). Derived from the column schema. */
export interface CustomColumn {
  id: string;
  label: string;
  width?: string;
  type?: CrmColumnType;
  options?: CrmDropdownOption[];
}

function customColsFromSchema(cols: CrmColumnDef[]): CustomColumn[] {
  return cols.filter((c) => !c.builtin).map((c) => ({
    id: c.id, label: c.label, width: c.width, type: c.type, options: c.options,
  }));
}

function visibleColIds(cols: CrmColumnDef[]): string[] {
  return cols.filter((c) => !c.hidden).map((c) => c.id);
}

/** Reconcile a stored column schema against the seed defaults — guarantees
 *  Person + Stage always exist even if a stored schema predates them. We
 *  also drop any preloaded built-ins (title/company/email/...) from the
 *  schema so older saves get cleaned up on next load. The user can still
 *  add Email / Phone / Title / etc. as their own custom columns; the
 *  underlying DB fields stay in place for Apollo / CSV import. */
const LEGACY_BUILTIN_IDS = new Set([
  // Old preloaded built-ins we don't surface by default anymore.
  "title", "company", "email", "phone", "linkedin", "temp",
  "sent", "opens", "replies", "nextStep", "source", "messageNotes", "notes",
  // Old non-functional row-checkbox column. Stored on legacy boards but
  // no longer rendered.
  "_select",
]);

function reconcileColumns(stored: CrmColumnDef[]): CrmColumnDef[] {
  const def = defaultColumns();
  const defById = new Map(def.map((d) => [d.id, d]));
  // 1. Drop legacy preloaded built-ins (Email, Phone, Title, etc.).
  // 2. For any column whose id matches a structural default (_select,
  //    person, stage), force builtin: true and the canonical type back
  //    on. This rescues schemas where an older save persisted Stage as
  //    a custom column with no options — which then rendered as empty
  //    dropdown cells instead of the kanban-driving stage chip.
  // Strip fr units from any stored width (built-in or custom). Fr columns
  // stretch with available space, so the table resized whenever the
  // sidebar collapsed. Pixel-only widths keep the layout stable.
  const dropFrWidth = (w?: string) => (w && !w.includes("fr") ? w : undefined);
  const trimmed = stored
    .filter((c) => !c.builtin || !LEGACY_BUILTIN_IDS.has(c.id))
    .map((c) => {
      const d = defById.get(c.id);
      if (d) {
        return {
          ...d,
          // Keep the user's label / hidden customisations, but reset
          // structural fields (builtin, type) so the renderer
          // dispatches to StageCell / Person / row-checkbox correctly.
          label: c.label || d.label,
          width: dropFrWidth(c.width) ?? d.width,
          hidden: c.hidden,
        };
      }
      // Custom column: also migrate any stored fr width to a sensible px
      // default. The user can drag-resize from there.
      return { ...c, width: dropFrWidth(c.width) ?? "200px" };
    });
  const known = new Set(trimmed.map((c) => c.id));
  const merged: CrmColumnDef[] = trimmed.slice();
  // Only re-add the truly required structural columns (_select + Person).
  // Stage is in defaultColumns() to seed new boards, but if the user has
  // explicitly removed it from the table we respect that — the kanban view
  // gets its stage list from the board's `stages` JSONB independently.
  for (const d of def) {
    if (!REQUIRED_COLS.includes(d.id)) continue;
    if (!known.has(d.id)) merged.push(d);
  }
  return merged;
}

function kanbanFieldsKey(boardId: string) { return `crm.kanbanfields.v1.${boardId}`; }
function rowHeightKey(boardId: string) { return `crm.rowheight.v1.${boardId}`; }

// Legacy localStorage keys — read once on first load to migrate into the
// server-backed schema, then never touched again.
function legacyColsKey(boardId: string) { return `crm.cols.v1.${boardId}`; }
function legacyCustomColsKey(boardId: string) { return `crm.customcols.v1.${boardId}`; }

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

/** Read row height from localStorage as an instant first-paint cache. The
 *  server is the source of truth; this just stops the table from blinking
 *  back to "medium" on remount before the boards GET lands. */
function loadRowHeightCached(boardId: string): CrmRowHeight {
  if (!boardId) return "medium";
  try {
    const raw = localStorage.getItem(rowHeightKey(boardId));
    if (raw === "short" || raw === "medium" || raw === "tall") return raw;
  } catch { /* noop */ }
  return "medium";
}
function cacheRowHeight(boardId: string, h: CrmRowHeight) {
  if (!boardId) return;
  try { localStorage.setItem(rowHeightKey(boardId), h); } catch { /* noop */ }
}

/** Pull any user-defined columns out of the legacy localStorage config and
 *  graft them onto the new minimal default schema. We deliberately ignore
 *  the legacy "visible built-ins" list — the new model says preloaded
 *  built-ins shouldn't exist in the schema at all. Returns null when the
 *  user has nothing to migrate, so the caller falls through to defaults. */
function migrateLegacyColumns(boardId: string): CrmColumnDef[] | null {
  if (!boardId) return null;
  let legacyCustom: { id: string; label: string; width?: string }[] = [];
  try {
    const raw = localStorage.getItem(legacyCustomColsKey(boardId));
    if (raw) {
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr)) {
        legacyCustom = (arr as { id: string; label: string; width?: string }[])
          .filter((c) => c && typeof c.id === "string" && typeof c.label === "string");
      }
    }
  } catch { /* noop */ }
  if (legacyCustom.length === 0) return null;

  const customs: CrmColumnDef[] = legacyCustom.map((c) => ({
    id: c.id, builtin: false, label: c.label, width: c.width ?? "200px", type: "text",
  }));
  return [...defaultColumns(), ...customs];
}

/** Turn a free-form label into a stable id: "Lead score" → "lead-score-<rnd>". */
function makeCustomColId(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "col";
  return `c_${slug}_${Math.random().toString(36).slice(2, 7)}`;
}

// --- Stage definitions ---
// Stages are user-editable per board — DEFAULT_STAGES seeds new boards,
// after that the inline kanban headers (rename / recolor / delete / +) own
// the lifecycle. Persisted to the board's `stages` JSONB so collaborators
// see the same kanban; localStorage holds a first-paint cache.
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
  // Local cache so a fresh mount in the same browser doesn't blink before
  // the boards GET lands. The server is the source of truth for shared
  // collaborators though — localStorage is a secondary.
  try { localStorage.setItem(stagesKey(boardId), JSON.stringify(stages)); } catch { /* noop */ }
  // Fire-and-forget PATCH so shared-with users see the change on their
  // next 8s poll. Non-fatal on failure — local cache keeps the owner's
  // view consistent.
  api.patch(`/api/crm/boards/${boardId}`, { stages }).catch(() => { /* non-fatal */ });
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

/** Single "Actions ▾" button that collapses every CRM-toolbar control
 *  into one popover. Render-prop API — children receives a `close`
 *  callback. Direct-action buttons (Import CSV, Add contact, Get email)
 *  should call `close()` alongside their own onClick so the popover
 *  dismisses cleanly. Submenu components (BoardShareMenu, KanbanFieldsMenu)
 *  must NOT call close so their nested popovers stay on top of Actions. */
function ActionsMenu({
  children,
}: {
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <div style={{ position: "relative" }}>
      <button className="pill-btn" onClick={() => setOpen((o) => !o)}>
        <IconChevD size={12} />Actions
      </button>
      {open && (
        <>
          <div className="board-menu-bg" onClick={close} />
          <div
            className="board-menu"
            style={{
              minWidth: 220,
              right: 0,
              left: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 4,
              padding: 8,
            }}
          >
            {children(close)}
          </div>
        </>
      )}
    </div>
  );
}

/** Dropdown menu that toggles which fields show on kanban cards (per
 *  board, persisted to localStorage). */
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

/** Kanban stage column header — inline editable. Double-click the title to
 *  rename, click the swatch to cycle color, hover for an X to delete (with
 *  reassignment of contacts in that stage to the next remaining one). */
function KanbanColumnHeader({
  stage, count, isFirst, isOnly, onRename, onCycleColor, onDelete,
}: {
  stage: StageDef;
  count: number;
  isFirst: boolean;
  isOnly: boolean;
  onRename: (label: string) => void;
  onCycleColor: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(stage.label);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) ref.current?.select(); }, [editing]);
  useEffect(() => { setDraft(stage.label); }, [stage.label]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== stage.label) onRename(next);
    else setDraft(stage.label);
  };

  return (
    <div className="kanban-head">
      <button
        className="kanban-bar kanban-bar-btn"
        title="Cycle color"
        onClick={onCycleColor}
      />
      {editing ? (
        <input
          ref={ref}
          className="kanban-title-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") { setDraft(stage.label); setEditing(false); }
          }}
        />
      ) : (
        <span
          className="kanban-title"
          onDoubleClick={() => setEditing(true)}
          title="Double-click to rename"
        >
          {stage.label}
        </span>
      )}
      <span className="kanban-count">{count}</span>
      {!isOnly && (
        <button
          className="kanban-del"
          title="Delete stage"
          onClick={onDelete}
        >
          <IconClose size={11} />
        </button>
      )}
    </div>
  );
}

function KanbanBoard({
  contacts, onOpen, onMoveStage, onDelete, fields, customCols, stages,
  onStagesChange, onReassign,
}: {
  contacts: CrmContact[];
  onOpen: (c: CrmContact) => void;
  onMoveStage: (contactId: string, stage: CrmStage) => void;
  onDelete: (id: string) => void;
  fields: string[];
  customCols: CustomColumn[];
  stages: StageDef[];
  onStagesChange: (next: StageDef[]) => void;
  /** Called when a stage is deleted so contacts in it can be moved. */
  onReassign: (fromId: string, toId: string) => void;
}) {
  const modal = useModal();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const newRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (adding) setTimeout(() => newRef.current?.focus(), 0); }, [adding]);

  const list = stages.length > 0 ? stages : DEFAULT_STAGES;
  const validIds = new Set(list.map((s) => s.id));
  const orphan = contacts.filter((c) => !validIds.has(c.stage));

  const renameStage = (id: string, label: string) => {
    onStagesChange(list.map((s) => (s.id === id ? { ...s, label } : s)));
  };
  const cycleStageColor = (id: string) => {
    onStagesChange(list.map((s) => {
      if (s.id !== id) return s;
      const idx = STAGE_PALETTE.findIndex((p) => p.color === s.color);
      const next = STAGE_PALETTE[(idx + 1 + STAGE_PALETTE.length) % STAGE_PALETTE.length]!;
      return { ...s, color: next.color, tint: next.tint };
    }));
  };
  const deleteStage = async (id: string) => {
    if (list.length <= 1) return;
    const target = list.find((s) => s.id === id);
    if (!target) return;
    const fallback = list.find((s) => s.id !== id)!;
    const ok = await modal.confirm({
      title: `Delete "${target.label}"?`,
      message: `Any contacts in this stage will move to "${fallback.label}".`,
      confirmLabel: "Delete stage",
      destructive: true,
    });
    if (!ok) return;
    onStagesChange(list.filter((s) => s.id !== id));
    onReassign(id, fallback.id);
  };
  const commitNewStage = () => {
    const label = newName.trim();
    if (!label) { setAdding(false); setNewName(""); return; }
    const palette = STAGE_PALETTE[list.length % STAGE_PALETTE.length]!;
    onStagesChange([...list, { id: makeStageId(label), label, ...palette }]);
    setAdding(false);
    setNewName("");
  };

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
            <KanbanColumnHeader
              stage={stage}
              count={items.length}
              isFirst={list.indexOf(stage) === 0}
              isOnly={list.length === 1}
              onRename={(label) => renameStage(stage.id, label)}
              onCycleColor={() => cycleStageColor(stage.id)}
              onDelete={() => deleteStage(stage.id)}
            />
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
      {/* Inline "+ Add stage" column at the end. */}
      <div className="kanban-col kanban-col-add" onClick={(e) => e.stopPropagation()}>
        {adding ? (
          <div className="kanban-add-row">
            <input
              ref={newRef}
              className="ed-input"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={commitNewStage}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitNewStage();
                if (e.key === "Escape") { setAdding(false); setNewName(""); }
              }}
              placeholder="Stage name"
            />
          </div>
        ) : (
          <button className="kanban-add-stage" onClick={() => setAdding(true)} title="Add stage">
            <span style={{ fontSize: 18, lineHeight: 1 }}>+</span> Add stage
          </button>
        )}
      </div>
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

// ---- Type-aware cell editors ----

const TYPE_LABELS: Record<CrmColumnType, string> = {
  text: "Text",
  longtext: "Long text",
  number: "Number",
  dropdown: "Dropdown",
  email: "Email",
  phone: "Phone",
  link: "Link",
  date: "Date",
  checkbox: "Checkbox",
  stage: "Stage",
  temp: "Temp",
  person: "Person",
  select: "Select",
};

/** Types the user can pick when adding a custom column or changing one's type.
 *  Built-in types like "stage", "temp", "person", "select" are excluded — those
 *  are reserved for built-in columns and have specialized rendering. */
const USER_PICKABLE_TYPES: CrmColumnType[] = [
  "text", "longtext", "number", "dropdown", "email", "phone", "link", "date", "checkbox",
];

const DROPDOWN_PALETTE = [
  "oklch(0.72 0.04 280)",
  "oklch(0.7 0.10 240)",
  "oklch(0.7 0.14 65)",
  "oklch(0.65 0.16 165)",
  "oklch(0.6 0.14 155)",
  "oklch(0.62 0.16 25)",
  "oklch(0.62 0.14 300)",
  "oklch(0.65 0.14 110)",
];

/** Saturate the option color into a tint background. */
function tintFor(color: string): string {
  return color.replace(/oklch\(([^)]+)\)/i, (_m, body) => {
    const parts = (body as string).split(/\s+/);
    if (parts.length < 3) return color;
    parts[0] = "0.95";
    return `oklch(${parts.join(" ")} / 0.7)`;
  });
}

function NumberCellEditor({
  value, onSave,
}: { value: number | null | undefined; onSave: (n: number) => void }) {
  return (
    <EditableCell
      value={value ?? ""}
      align="center"
      onSave={(v) => onSave(Number(v) || 0)}
    />
  );
}

/** Excel / Notion-style multi-line text editor. The display preserves
 *  newlines; clicking expands into a textarea where Enter commits,
 *  Shift+Enter inserts a newline, Escape cancels. Content auto-grows
 *  vertically while editing so long notes feel like a real spreadsheet. */
function LongTextCellEditor({
  value, onSave,
}: { value: string | null | undefined; onSave: (v: string) => void }) {
  const [v, setV] = useState(value ?? "");
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { setV(value ?? ""); }, [value]);

  // Compute the initial textarea size from the current value so the very
  // first frame already shows the right height — running autoGrow inside
  // the ref callback caused a 1-frame jitter as the height jumped from
  // the rows= default to scrollHeight.
  const initialRows = Math.max(2, Math.min(10, (value ?? "").split("\n").length));

  const commit = () => {
    setEditing(false);
    if (v !== (value ?? "")) onSave(v);
  };

  const autoGrow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  };

  // Focus + place caret at end + size to content, all in one paint frame
  // after mount so the cursor doesn't visibly snap into place.
  useEffect(() => {
    if (!editing) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(v.length, v.length);
    autoGrow(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  if (editing) {
    return (
      <textarea
        ref={ref}
        className="ed-input ed-textarea"
        value={v}
        onChange={(e) => { setV(e.target.value); autoGrow(e.currentTarget); }}
        onBlur={commit}
        onKeyDown={(e) => {
          // Excel feel: Enter commits, Shift+Enter newline, Escape cancels.
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); return; }
          if (e.key === "Escape") { e.preventDefault(); setV(value ?? ""); setEditing(false); }
        }}
        onClick={(e) => e.stopPropagation()}
        rows={initialRows}
      />
    );
  }
  return (
    <span
      className="ed-cell ed-cell-multi"
      onClick={(e) => { e.stopPropagation(); setEditing(true); }}
    >
      {v || <em style={{ color: "var(--text-mute)" }}>—</em>}
    </span>
  );
}

function CheckboxCellEditor({
  value, onSave,
}: { value: string | null | undefined; onSave: (v: string) => void }) {
  const on = value === "true" || value === "1" || value === "yes";
  return (
    <span
      className="cb-cell"
      onClick={(e) => { e.stopPropagation(); onSave(on ? "" : "true"); }}
      title={on ? "Uncheck" : "Check"}
    >
      <span className={`cb-box${on ? " on" : ""}`}>
        {on && <IconCheck size={10} />}
      </span>
    </span>
  );
}

function DateCellEditor({
  value, onSave,
}: { value: string | null | undefined; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  const display = value ? formatDateDisplay(value) : "";
  return editing ? (
    <input
      ref={ref}
      type="date"
      className="ed-input"
      defaultValue={value ?? ""}
      onBlur={(e) => { setEditing(false); if (e.target.value !== (value ?? "")) onSave(e.target.value); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setEditing(false);
      }}
      onClick={(e) => e.stopPropagation()}
    />
  ) : (
    <span
      className="ed-cell"
      onClick={(e) => { e.stopPropagation(); setEditing(true); }}
      style={{ width: "100%" }}
    >
      {display || <em style={{ color: "var(--text-mute)" }}>—</em>}
    </span>
  );
}

function formatDateDisplay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function DropdownCellEditor({
  value, options, onSave, onOptionsChange,
}: {
  value: string | null | undefined;
  options: CrmDropdownOption[];
  onSave: (v: string) => void;
  /** When provided, the cell exposes an inline "+ add option" input so the
   *  user can grow the option set without going to the column header menu. */
  onOptionsChange?: (next: CrmDropdownOption[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const opt = options.find((o) => o.value === value);
  const color = opt?.color ?? DROPDOWN_PALETTE[0]!;

  const addOption = () => {
    const v = draft.trim();
    if (!v || !onOptionsChange) return;
    if (options.some((o) => o.value === v)) {
      // Already exists — just select it.
      onSave(v); setDraft(""); setOpen(false); return;
    }
    // Pick the first palette colour not already in use so newly-added
    // options don't collide with existing ones until the palette is full,
    // then fall back to round-robin so we never run out.
    const used = new Set(options.map((o) => o.color).filter(Boolean));
    const nextColor = DROPDOWN_PALETTE.find((c) => !used.has(c))
      ?? DROPDOWN_PALETTE[options.length % DROPDOWN_PALETTE.length]!;
    onOptionsChange([...options, { value: v, color: nextColor }]);
    onSave(v);
    setDraft("");
    setOpen(false);
  };

  return (
    <div className="stage-cell" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
      {value ? (
        <span
          className="tbl-stage"
          style={{ "--stage-color": color, "--stage-tint": tintFor(color) } as React.CSSProperties}
        >
          {value}
        </span>
      ) : (
        <span className="ed-cell" style={{ color: "var(--text-mute)" }}><em>—</em></span>
      )}
      {open && (
        <div className="stage-menu" onClick={(e) => e.stopPropagation()}>
          {options.map((o) => (
            <button
              key={o.value}
              onClick={(e) => { e.stopPropagation(); onSave(o.value); setOpen(false); }}
            >
              <span className="stage-dot" style={{ background: o.color ?? DROPDOWN_PALETTE[0]! }} />
              {o.value}
            </button>
          ))}
          {onOptionsChange && (
            <div className="dd-add">
              <input
                ref={inputRef}
                className="ed-input"
                style={{ margin: 0, fontSize: 12 }}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); addOption(); }
                  if (e.key === "Escape") { setDraft(""); setOpen(false); }
                }}
                placeholder={options.length === 0 ? "Type a value, press Enter…" : "+ Add option"}
                autoFocus={options.length === 0}
              />
            </div>
          )}
          {!onOptionsChange && options.length === 0 && (
            <div style={{ padding: 8, fontSize: 11, color: "var(--text-mute)" }}>
              No options yet.
            </div>
          )}
          {value && (
            <>
              <div className="bm-sep" />
              <button onClick={(e) => { e.stopPropagation(); onSave(""); setOpen(false); }}>
                <span className="stage-dot" style={{ background: "var(--hairline)" }} />
                Clear
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Generic link cell — same UX as LinkedInCell but doesn't normalize. */
function LinkCellEditor({
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
        placeholder="https://..."
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
  const display = value.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
  const href = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return (
    <span
      className="ed-cell"
      onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
      onClick={(e) => e.stopPropagation()}
      style={{ width: "100%", display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}
      title="Double-click to edit"
    >
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          color: "var(--accent)", textDecoration: "none",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1,
        }}
      >
        {display}
      </a>
    </span>
  );
}

/** Email cell — chip with a mailto link when filled, EditableCell when not. */
function EmailCellEditor({
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
        type="email"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") { setV(value ?? ""); setEditing(false); }
        }}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }
  return (
    <span
      className="ed-cell"
      onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
      onClick={(e) => { e.stopPropagation(); if (!value) setEditing(true); }}
      style={{ width: "100%", display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}
      title={value ? "Double-click to edit" : "Click to add"}
    >
      {value ? (
        <a
          href={`mailto:${value}`}
          style={{ color: "var(--accent)", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}
        >
          {value}
        </a>
      ) : (
        <em style={{ color: "var(--text-mute)" }}>—</em>
      )}
    </span>
  );
}

/** Inline editable column header. Click the label to rename. The chevron
 *  on hover opens a menu with type / dropdown options / hide / delete /
 *  width controls. */
function HeaderCell({
  col, onChange, onDelete, onDragStart, onDragOver, onDrop, dropEdge, onResizeStart,
}: {
  col: CrmColumnDef;
  onChange: (next: CrmColumnDef) => void;
  onDelete: () => void;
  /** Drag-and-drop reordering — wired up by the parent TableView. */
  onDragStart: (id: string) => void;
  onDragOver: (id: string, edge: "left" | "right") => void;
  onDrop: () => void;
  /** Whether to show the drop indicator on this column's left or right edge. */
  dropEdge: "left" | "right" | null;
  /** Begin a column resize. The parent TableView owns the live width state
   *  so the grid-template-columns string can show real-time feedback. */
  onResizeStart: (colId: string, startX: number, startWidthPx: number) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(col.label);
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (renaming) ref.current?.select(); }, [renaming]);
  useEffect(() => { setDraft(col.label); }, [col.label]);

  const commitRename = () => {
    setRenaming(false);
    const next = draft.trim();
    if (next && next !== col.label) onChange({ ...col, label: next });
    else setDraft(col.label);
  };

  // Person is required as the row anchor — can rename + width-tweak but
  // can't be hidden or deleted.
  const isStructureLocked = REQUIRED_COLS.includes(col.id);
  // Built-in columns whose underlying field has fixed semantics (the
  // person card, the kanban stage chip) can't have their type swapped.
  const isTypeLocked = col.builtin;

  const onResizePointerDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const cell = (e.currentTarget as HTMLElement).closest(".tbl-cell") as HTMLElement | null;
    if (!cell) return;
    onResizeStart(col.id, e.clientX, cell.getBoundingClientRect().width);
  };

  return (
    <div
      className={`hdr-cell${dropEdge ? ` drop-${dropEdge}` : ""}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/x-col-id", col.id);
        onDragStart(col.id);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const edge = e.clientX < rect.left + rect.width / 2 ? "left" : "right";
        onDragOver(col.id, edge);
      }}
      onDrop={(e) => { e.preventDefault(); onDrop(); }}
    >
      {renaming ? (
        <input
          ref={ref}
          className="hdr-rename"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") { setDraft(col.label); setRenaming(false); }
          }}
        />
      ) : (
        <span
          className="hdr-label"
          onDoubleClick={() => setRenaming(true)}
          title="Double-click to rename"
        >
          {col.label || <span style={{ color: "var(--text-mute)" }}>—</span>}
        </span>
      )}
      <button
        className="hdr-chev"
        onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}
        title="Column options"
      >
        <IconChevD size={10} />
      </button>
      {menuOpen && (
        <>
          <div className="board-menu-bg" onClick={() => setMenuOpen(false)} />
          <div className="hdr-menu" onClick={(e) => e.stopPropagation()}>
            <button className="bm-item" onClick={() => { setRenaming(true); setMenuOpen(false); }}>
              <span style={{ width: 14, textAlign: "center" }}>Aa</span>
              <span style={{ flex: 1 }}>Rename</span>
            </button>
            {!isTypeLocked && (
              <>
                <div className="bm-sep" />
                <div className="bm-label">Type</div>
                <div className="hdr-type-grid">
                  {USER_PICKABLE_TYPES.map((t) => (
                    <button
                      key={t}
                      className={`type-chip${col.type === t ? " on" : ""}`}
                      onClick={() => onChange({ ...col, type: t, options: t === "dropdown" ? (col.options ?? []) : undefined })}
                    >
                      {TYPE_LABELS[t]}
                    </button>
                  ))}
                </div>
              </>
            )}
            {col.type === "dropdown" && (
              <>
                <div className="bm-sep" />
                <DropdownOptionsEditor
                  value={col.options ?? []}
                  onChange={(opts) => onChange({ ...col, options: opts })}
                />
              </>
            )}
            <div className="bm-sep" />
            <div className="bm-label">Width</div>
            <div className="hdr-type-grid">
              {([
                { id: "narrow", label: "Narrow", w: "90px" },
                { id: "normal", label: "Normal", w: "200px" },
                { id: "wide",   label: "Wide",   w: "2fr" },
              ] as const).map((p) => (
                <button
                  key={p.id}
                  className={`type-chip${col.width === p.w ? " on" : ""}`}
                  onClick={() => onChange({ ...col, width: p.w })}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {!isStructureLocked && (
              <>
                <div className="bm-sep" />
                <button className="bm-item" onClick={() => { onChange({ ...col, hidden: true }); setMenuOpen(false); }}>
                  <IconClose size={11} /><span>Hide column</span>
                </button>
                {!col.builtin && (
                  <button
                    className="bm-item"
                    style={{ color: "var(--danger, oklch(0.55 0.2 25))" }}
                    onClick={() => { onDelete(); setMenuOpen(false); }}
                  >
                    <IconClose size={11} /><span>Delete column</span>
                  </button>
                )}
              </>
            )}
          </div>
        </>
      )}
      <span
        className="hdr-resize"
        onPointerDown={onResizePointerDown}
        onMouseDown={(e) => e.stopPropagation()}
        onDragStart={(e) => e.preventDefault()}
        draggable={false}
        title="Drag to resize"
      />
    </div>
  );
}

/** Inline editor for a dropdown column's option list. */
function DropdownOptionsEditor({
  value, onChange,
}: { value: CrmDropdownOption[]; onChange: (next: CrmDropdownOption[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (value.some((o) => o.value === v)) { setDraft(""); return; }
    const used = new Set(value.map((o) => o.color).filter(Boolean));
    const color = DROPDOWN_PALETTE.find((c) => !used.has(c))
      ?? DROPDOWN_PALETTE[value.length % DROPDOWN_PALETTE.length]!;
    onChange([...value, { value: v, color }]);
    setDraft("");
  };
  const remove = (val: string) => onChange(value.filter((o) => o.value !== val));
  const recolor = (val: string) => onChange(value.map((o) => {
    if (o.value !== val) return o;
    const idx = DROPDOWN_PALETTE.indexOf(o.color ?? DROPDOWN_PALETTE[0]!);
    const next = DROPDOWN_PALETTE[(idx + 1) % DROPDOWN_PALETTE.length]!;
    return { ...o, color: next };
  }));
  return (
    <div style={{ padding: "4px 8px 8px" }}>
      <div className="bm-label" style={{ padding: "6px 0 6px" }}>Options</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {value.map((o) => (
          <div key={o.value} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              className="stage-dot-btn"
              onClick={() => recolor(o.value)}
              title="Cycle color"
              style={{ background: o.color ?? DROPDOWN_PALETTE[0]! }}
            />
            <span style={{ flex: 1, fontSize: 12, color: "var(--text)" }}>{o.value}</span>
            <button
              className="hdr-x"
              onClick={() => remove(o.value)}
              title="Remove option"
            >
              <IconClose size={10} />
            </button>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <input
          className="ed-input"
          style={{ flex: 1, margin: 0 }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder="Add option…"
        />
        <button className="pill-btn" onClick={add}><IconCheck size={11} />Add</button>
      </div>
    </div>
  );
}

/** "+" pill at the end of the header row. Click → choose type → name it. */
/** Shared two-step popover: choose a column type → name it → fire onCreate.
 *  Used by both the table's "+" pill and the drawer's "+ Add a field" row
 *  so type-list / labels / sizing rules stay in one place. */
function ColumnTypeWizard({
  onCreate, onClose, anchor = "left", noun = "column",
}: {
  onCreate: (col: CrmColumnDef) => void;
  onClose: () => void;
  /** Which edge of the trigger the popover hugs. Right is for the table's
   *  "+" pill at the rightmost column; left for the drawer add-field row. */
  anchor?: "left" | "right";
  /** Word used in copy — "column" in the table, "field" in the drawer. */
  noun?: "column" | "field";
}) {
  const [step, setStep] = useState<"choose" | "name">("choose");
  const [pickedType, setPickedType] = useState<CrmColumnType>("text");
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (step === "name") setTimeout(() => inputRef.current?.focus(), 0); }, [step]);

  const create = () => {
    const label = name.trim();
    if (!label) return;
    const id = makeCustomColId(label);
    onCreate({
      id, builtin: false, label, type: pickedType,
      // Fixed pixel widths only — fr units stretch with the available
      // space, which means the column resizes whenever the sidebar
      // collapses. Pixel widths keep the layout stable across viewports.
      width: pickedType === "checkbox" ? "80px" : pickedType === "number" ? "90px" : "200px",
      options: pickedType === "dropdown" ? [] : undefined,
    });
    onClose();
  };

  const positionStyle: React.CSSProperties = anchor === "right"
    ? { left: "auto", right: 0 }
    : { left: 0, right: "auto" };

  return (
    <>
      <div className="board-menu-bg" onClick={onClose} />
      <div
        className="hdr-menu"
        style={{ minWidth: 240, maxWidth: "min(320px, calc(100vw - 24px))", ...positionStyle }}
        onClick={(e) => e.stopPropagation()}
      >
        {step === "choose" ? (
          <>
            <div className="bm-label">Add a {noun}</div>
            <div className="hdr-type-grid">
              {USER_PICKABLE_TYPES.map((t) => (
                <button
                  key={t}
                  className="type-chip"
                  onClick={() => { setPickedType(t); setStep("name"); }}
                >
                  {TYPE_LABELS[t]}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="bm-label">Name your {(TYPE_LABELS[pickedType] ?? "").toLowerCase()} {noun}</div>
            <div style={{ padding: "4px 8px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
              <input
                ref={inputRef}
                className="ed-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); create(); }
                  if (e.key === "Escape") onClose();
                }}
                placeholder="e.g. Lead score"
              />
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <button className="pill-btn" onClick={() => setStep("choose")}>Back</button>
                <button className="pill-btn primary" onClick={create}>
                  <IconCheck size={11} />Add
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function AddColumnButton({
  onAdd,
}: {
  onAdd: (col: CrmColumnDef) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="hdr-cell hdr-add">
      <button className="hdr-add-btn" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} title="Add column">
        +
      </button>
      {open && (
        <ColumnTypeWizard
          onCreate={(col) => onAdd(col)}
          onClose={() => setOpen(false)}
          anchor="right"
          noun="column"
        />
      )}
    </div>
  );
}

function TableView({
  contacts, onOpen, onPatch, columns, onColumnsChange, stages, rowHeight,
}: {
  contacts: CrmContact[];
  onOpen: (c: CrmContact) => void;
  onPatch: (id: string, patch: Partial<CrmContact>) => void;
  columns: CrmColumnDef[];
  onColumnsChange: (next: CrmColumnDef[]) => void;
  stages: StageDef[];
  rowHeight: CrmRowHeight;
}) {
  const visibleCols = useMemo(() => columns.filter((c) => !c.hidden), [columns]);

  // Live width override during a column resize — set on every pointermove so
  // the grid-template-columns string immediately reflects the new width.
  // Without this, setting `cell.style.width` on a single grid child has no
  // effect (the parent grid template owns the width) and the user gets no
  // feedback until release.
  const [liveWidth, setLiveWidth] = useState<{ id: string; px: number } | null>(null);
  // Track the active resize cleanup so the window listeners get removed
  // even if the component unmounts mid-drag (e.g. the user switches
  // boards while resizing) — otherwise the next pointermove anywhere in
  // the page would still call into a stale setLiveWidth.
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => { resizeCleanupRef.current?.(); resizeCleanupRef.current = null; };
  }, []);

  const startResize = (colId: string, startX: number, startW: number) => {
    // Cancel any in-flight resize before starting a new one.
    resizeCleanupRef.current?.();
    const onMove = (ev: PointerEvent) => {
      const next = Math.max(60, Math.round(startW + (ev.clientX - startX)));
      setLiveWidth({ id: colId, px: next });
    };
    const onUp = (ev: PointerEvent) => {
      cleanup();
      const next = Math.max(60, Math.round(startW + (ev.clientX - startX)));
      setLiveWidth(null);
      // Persist the new width in the schema (which then syncs to collaborators).
      onColumnsChange(columns.map((c) => (c.id === colId ? { ...c, width: `${next}px` } : c)));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const gridTemplate = visibleCols.map((c) => {
    if (liveWidth && liveWidth.id === c.id) return `${liveWidth.px}px`;
    return c.width ?? "200px";
  }).join(" ") + " 36px";

  const updateCol = (id: string, patch: Partial<CrmColumnDef>) => {
    onColumnsChange(columns.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };
  const replaceCol = (next: CrmColumnDef) => updateCol(next.id, next);
  const deleteCol = (id: string) => onColumnsChange(columns.filter((c) => c.id !== id));
  const addCol = (col: CrmColumnDef) => onColumnsChange([...columns, col]);

  // ---- Column reorder via drag-and-drop on header cells ----
  const [draggingColId, setDraggingColId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; edge: "left" | "right" } | null>(null);

  const reorderColumn = (sourceId: string, targetId: string, edge: "left" | "right") => {
    if (sourceId === targetId) return;
    const sourceIdx = columns.findIndex((c) => c.id === sourceId);
    const targetIdx = columns.findIndex((c) => c.id === targetId);
    if (sourceIdx < 0 || targetIdx < 0) return;
    const next = columns.slice();
    const [moved] = next.splice(sourceIdx, 1);
    if (!moved) return;
    // Compute insertion index in the new array (after splice).
    let insertAt = next.findIndex((c) => c.id === targetId);
    if (edge === "right") insertAt += 1;
    if (insertAt < 0) insertAt = next.length;
    next.splice(insertAt, 0, moved);
    onColumnsChange(next);
  };

  const onHeaderDragStart = (id: string) => setDraggingColId(id);
  const onHeaderDragOver = (id: string, edge: "left" | "right") => {
    if (!draggingColId) return;
    setDropTarget((cur) => (cur?.id === id && cur.edge === edge ? cur : { id, edge }));
  };
  const onHeaderDrop = () => {
    if (draggingColId && dropTarget) reorderColumn(draggingColId, dropTarget.id, dropTarget.edge);
    setDraggingColId(null);
    setDropTarget(null);
  };

  const isNumeric = (col: CrmColumnDef) => NUMERIC_TYPES.includes(col.type);

  const renderCell = (col: CrmColumnDef, p: CrmContact, i: number) => {
    if (!col.builtin) {
      const val = (p.customFields ?? {})[col.id] ?? "";
      const setVal = (v: string) => onPatch(p.id, { customFields: { [col.id]: v } });
      const setOptions = (next: CrmDropdownOption[]) => replaceCol({ ...col, options: next });
      switch (col.type) {
        case "number":   return <NumberCellEditor value={val ? Number(val) : null} onSave={(n) => setVal(String(n))} />;
        case "dropdown": return <DropdownCellEditor value={val} options={col.options ?? []} onSave={setVal} onOptionsChange={setOptions} />;
        case "email":    return <EmailCellEditor value={val} onSave={setVal} />;
        case "phone":    return <EditableCell value={val} onSave={setVal} />;
        case "link":     return <LinkCellEditor value={val} onSave={setVal} />;
        case "date":     return <DateCellEditor value={val} onSave={setVal} />;
        case "checkbox": return <CheckboxCellEditor value={val} onSave={setVal} />;
        case "longtext": return <LongTextCellEditor value={val} onSave={setVal} />;
        case "text":
        default:         return <EditableCell value={val} onSave={setVal} />;
      }
    }
    switch (col.id) {
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
      case "email":   return <EmailCellEditor value={p.email} onSave={(v) => onPatch(p.id, { email: v })} />;
      case "phone":   return <EditableCell value={p.phone} onSave={(v) => onPatch(p.id, { phone: v })} />;
      case "linkedin": return (
        <LinkedInCell
          value={p.linkedin}
          onSave={(v) => onPatch(p.id, { linkedin: normalizeLinkedInInput(v) ?? v })}
        />
      );
      case "stage":   return <StageCell stage={p.stage} stages={stages} onChange={(v) => onPatch(p.id, { stage: v })} />;
      case "temp":    return <TempCell  temp={p.temp}   onChange={(v) => onPatch(p.id, { temp: v })} />;
      case "sent":    return <NumberCellEditor value={p.sent}    onSave={(n) => onPatch(p.id, { sent: n })} />;
      case "opens":   return <NumberCellEditor value={p.opens}   onSave={(n) => onPatch(p.id, { opens: n })} />;
      case "replies": return <NumberCellEditor value={p.replies} onSave={(n) => onPatch(p.id, { replies: n })} />;
      case "nextStep":return <EditableCell value={p.nextStep} onSave={(v) => onPatch(p.id, { nextStep: v })} />;
      case "source":  return <span className="src-chip">{p.source ?? ""}</span>;
      case "messageNotes": return <LongTextCellEditor value={p.messageNotes} onSave={(v) => onPatch(p.id, { messageNotes: v })} />;
      case "notes":   return <LongTextCellEditor value={p.notes} onSave={(v) => onPatch(p.id, { notes: v })} />;
      default:        return null;
    }
  };

  return (
    <div className={`tbl-wrap rh-${rowHeight}`}>
      <div className="tbl">
        <div className="tbl-row tbl-head" style={{ gridTemplateColumns: gridTemplate }}>
          {visibleCols.map((c) => (
            <div key={c.id} className={`tbl-cell hdr${isNumeric(c) ? " c-num" : ""}`}>
              <HeaderCell
                col={c}
                onChange={replaceCol}
                onDelete={() => deleteCol(c.id)}
                onDragStart={onHeaderDragStart}
                onDragOver={onHeaderDragOver}
                onDrop={onHeaderDrop}
                dropEdge={dropTarget?.id === c.id ? dropTarget.edge : null}
                onResizeStart={startResize}
              />
            </div>
          ))}
          <div className="tbl-cell hdr">
            <AddColumnButton onAdd={addCol} />
          </div>
        </div>
        {contacts.map((p, i) => (
          <div
            key={p.id}
            className="tbl-row"
            onClick={() => onOpen(p)}
            style={{ gridTemplateColumns: gridTemplate }}
          >
            {visibleCols.map((c) => (
              <div key={c.id} className={`tbl-cell${isNumeric(c) ? " c-num" : ""}${c.id === "person" ? " c-name" : ""}`}>
                {renderCell(c, p, i)}
              </div>
            ))}
            <div className="tbl-cell" />
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

/** Toolbar pill for switching row height between short / medium / tall. */
function RowHeightMenu({
  value, onChange,
}: { value: CrmRowHeight; onChange: (next: CrmRowHeight) => void }) {
  const [open, setOpen] = useState(false);
  const labels: Record<CrmRowHeight, string> = { short: "Short", medium: "Medium", tall: "Tall" };
  return (
    <div style={{ position: "relative" }}>
      <button className="pill-btn" onClick={() => setOpen((o) => !o)} title="Row height">
        <IconList size={12} />{labels[value]}
      </button>
      {open && (
        <>
          <div className="board-menu-bg" onClick={() => setOpen(false)} />
          <div className="board-menu" style={{ minWidth: 160, right: 0, left: "auto" }}>
            {(["short", "medium", "tall"] as const).map((h) => (
              <button
                key={h}
                className={`bm-item${value === h ? " active" : ""}`}
                onClick={() => { onChange(h); setOpen(false); }}
              >
                <span style={{ flex: 1 }}>{labels[h]}</span>
                {value === h && <IconCheck size={11} />}
              </button>
            ))}
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

// ========== CRMDrawer — per-contact side panel ==========

/** Inline "+ Add field" row at the bottom of the drawer's properties grid.
 *  Reuses the shared ColumnTypeWizard so the type list and copy stay in
 *  one place. */
function DrawerAddField({ onAdd }: { onAdd: (col: CrmColumnDef) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="dp-add-row">
      <button className="dp-add-btn" onClick={() => setOpen(true)}>
        <span style={{ fontSize: 14, lineHeight: 1 }}>+</span>
        <span>Add a field</span>
      </button>
      {open && (
        <ColumnTypeWizard
          onCreate={(col) => onAdd(col)}
          onClose={() => setOpen(false)}
          anchor="left"
          noun="field"
        />
      )}
    </div>
  );
}

export function CRMDrawer({
  contact, idx, onClose, onPatch, onDelete, columns = [], stages = DEFAULT_STAGES, onColumnsChange,
}: {
  contact: CrmContact;
  idx: number;
  onClose: () => void;
  onPatch: (id: string, patch: Partial<CrmContact>) => void;
  onDelete?: (id: string) => void;
  /** Full board column schema so the drawer mirrors what's on the table. */
  columns?: CrmColumnDef[];
  stages?: StageDef[];
  /** Persist a schema change (used by the inline "+ Add field" button). */
  onColumnsChange?: (next: CrmColumnDef[]) => void;
}) {
  const modal = useModal();
  const stageList = stages.length > 0 ? stages : DEFAULT_STAGES;

  const advanceStage = () => {
    const i = stageList.findIndex((s) => s.id === contact.stage);
    const next = stageList[Math.min(stageList.length - 1, i + 1)]!;
    onPatch(contact.id, { stage: next.id as CrmStage });
  };

  // Properties block — driven by the user's column schema, in the user's
  // chosen order. The hero already shows Person / Stage / Temp so we don't
  // repeat them; the row-select column is irrelevant here.
  const propCols = columns.filter(
    (c) => c.id !== "person" && c.id !== "stage" && c.id !== "temp" && !c.hidden,
  );

  /** Render the right cell editor for the column's type. Built-in columns
   *  back real contact fields; custom ones live in customFields[id]. */
  const renderProp = (col: CrmColumnDef): React.ReactNode => {
    if (!col.builtin) {
      const val = (contact.customFields ?? {})[col.id] ?? "";
      const setVal = (v: string) => onPatch(contact.id, { customFields: { [col.id]: v } });
      const setOptions = onColumnsChange
        ? (next: CrmDropdownOption[]) => onColumnsChange(columns.map((x) => (x.id === col.id ? { ...x, options: next } : x)))
        : undefined;
      switch (col.type) {
        case "number":   return <NumberCellEditor value={val ? Number(val) : null} onSave={(n) => setVal(String(n))} />;
        case "dropdown": return <DropdownCellEditor value={val} options={col.options ?? []} onSave={setVal} onOptionsChange={setOptions} />;
        case "email":    return <EmailCellEditor value={val} onSave={setVal} />;
        case "link":     return <LinkCellEditor value={val} onSave={setVal} />;
        case "date":     return <DateCellEditor value={val} onSave={setVal} />;
        case "checkbox": return <CheckboxCellEditor value={val} onSave={setVal} />;
        case "longtext": return <LongTextCellEditor value={val} onSave={setVal} />;
        default:         return <EditableCell value={val} onSave={setVal} />;
      }
    }
    switch (col.id) {
      case "title":    return <EditableCell value={contact.title}   onSave={(v) => onPatch(contact.id, { title: v })} />;
      case "company":  return <EditableCell value={contact.company} onSave={(v) => onPatch(contact.id, { company: v })} />;
      case "email":    return <EmailCellEditor value={contact.email} onSave={(v) => onPatch(contact.id, { email: v })} />;
      case "phone":    return <EditableCell value={contact.phone} onSave={(v) => onPatch(contact.id, { phone: v })} />;
      case "linkedin": return (
        <LinkedInCell
          value={contact.linkedin}
          onSave={(v) => onPatch(contact.id, { linkedin: normalizeLinkedInInput(v) ?? v })}
        />
      );
      case "sent":         return <NumberCellEditor value={contact.sent}    onSave={(n) => onPatch(contact.id, { sent: n })} />;
      case "opens":        return <NumberCellEditor value={contact.opens}   onSave={(n) => onPatch(contact.id, { opens: n })} />;
      case "replies":      return <NumberCellEditor value={contact.replies} onSave={(n) => onPatch(contact.id, { replies: n })} />;
      case "nextStep":     return <EditableCell value={contact.nextStep} onSave={(v) => onPatch(contact.id, { nextStep: v })} />;
      case "source":       return <EditableCell value={contact.source} onSave={(v) => onPatch(contact.id, { source: v })} />;
      case "messageNotes": return <LongTextCellEditor value={contact.messageNotes} onSave={(v) => onPatch(contact.id, { messageNotes: v })} />;
      case "notes":        return <LongTextCellEditor value={contact.notes} onSave={(v) => onPatch(contact.id, { notes: v })} />;
      default:             return null;
    }
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
        <div className="drawer-body drawer-body-page">
          <div className="profile-hero">
            <div className="profile-avatar profile-avatar-lg" style={{ background: avatarGrad(idx) }}>{initials(contact.name)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="profile-name">
                <EditableCell
                  value={contact.name}
                  onSave={(v) => { if (v.trim()) onPatch(contact.id, { name: v.trim() }); }}
                />
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                <StageCell stage={contact.stage} stages={stageList} onChange={(v) => onPatch(contact.id, { stage: v })} />
              </div>
            </div>
          </div>

          {/* Properties — one row per visible column on the board. Empty
              fields show a faint placeholder so the user knows where to
              type, just like a Notion page. */}
          <div className="drawer-props">
            {propCols.map((c) => (
              <div key={c.id} className="dp-row">
                <span className="dp-label">{c.label}</span>
                <div className="dp-value">{renderProp(c)}</div>
                {onColumnsChange && (
                  <button
                    className="dp-del"
                    title={`Delete "${c.label}" field`}
                    onClick={() => onColumnsChange(columns.filter((x) => x.id !== c.id))}
                  >
                    <IconClose size={11} />
                  </button>
                )}
              </div>
            ))}
            {onColumnsChange && (
              <DrawerAddField
                onAdd={(col) => onColumnsChange([...columns, col])}
              />
            )}
          </div>

          {contact.background && (
            <div className="drawer-page-block">
              <div className="dp-section-label">Background</div>
              <div
                className="drawer-bg-block"
                // Background is LLM-generated markdown with inline links.
                // Render it minimally — linkify [label](url) and preserve
                // bullets. Source: trusted backend, no user input.
                dangerouslySetInnerHTML={{ __html: renderBackgroundMarkdown(contact.background) }}
              />
            </div>
          )}

          {/* Notion-style page body — one big freeform notes area. */}
          <div className="drawer-page-block">
            <div className="dp-section-label">Notes</div>
            <textarea
              className="drawer-page-notes"
              defaultValue={contact.notes ?? ""}
              placeholder="Type anything — meeting notes, follow-ups, ideas, what they said…"
              onBlur={(e) => {
                const v = e.target.value;
                if ((contact.notes ?? "") !== v) onPatch(contact.id, { notes: v });
              }}
            />
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
  const [columns, setColumns] = useState<CrmColumnDef[]>(defaultColumns);
  const [rowHeight, setRowHeight] = useState<CrmRowHeight>("medium");
  const [kanbanFields, setKanbanFields] = useState<string[]>(KANBAN_DEFAULT);
  const [stages, setStages] = useState<StageDef[]>(DEFAULT_STAGES);
  // Derived backward-compat shapes for callsites that haven't been
  // refactored to consume the full schema (KanbanCard, CRMDrawer, etc).
  const customCols = useMemo(() => customColsFromSchema(columns), [columns]);
  const visibleCols = useMemo(() => visibleColIds(columns), [columns]);

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

  // Whenever the active board changes, prime kanban + stages from local
  // caches as a first paint. Columns and row height come from the server
  // (see the effect that follows `active?.columns` below); we only seed
  // sensible defaults here so the table doesn't flash empty on board
  // switch.
  useEffect(() => {
    if (!activeId) return;
    setRowHeight(loadRowHeightCached(activeId));
    setKanbanFields(loadKanbanFields(activeId, []));
    setStages(loadStages(activeId));
  }, [activeId]);

  // Callback refs — `onFlash` and `onBoardsChange` are re-created on every
  // parent render (plain arrow functions), so listing them as effect deps
  // was causing the contacts effect to tear down + re-mount on every
  // parent render. That thrashed the fetch, created overlapping polling
  // intervals, and made board switches feel stuck on stale data. Pin the
  // callbacks in a ref so the effect only re-runs on the thing that
  // actually matters: activeId.
  const onFlashRef = useRef(onFlash);
  const onBoardsChangeRef = useRef(onBoardsChange);
  useEffect(() => { onFlashRef.current = onFlash; }, [onFlash]);
  useEffect(() => { onBoardsChangeRef.current = onBoardsChange; }, [onBoardsChange]);

  // Load contacts + boards when active board changes, then poll both every
  // 8s so shared boards reflect what other collaborators are doing without
  // a hard refresh.
  useEffect(() => {
    if (!activeId) return;
    // Clear contacts immediately on board switch so the UI doesn't linger
    // on the old board's rows while the new GET is in flight. User reported
    // "content actually doesnt update the people" on board switch — the
    // data was updating, but perceptibly late. Optimistic clear fixes that.
    setContacts([]);

    let stopped = false;
    const loadContacts = () => {
      api.get<{ contacts: CrmContact[] }>(`/api/crm/boards/${activeId}/contacts`)
        .then((r) => { if (!stopped) setContacts(r.contacts); })
        .catch((e) => { if (!stopped) onFlashRef.current(`Load contacts failed: ${e.message}`); });
    };
    const loadBoards = () => {
      api.get<{ boards: CrmBoard[] }>("/api/crm/boards")
        .then((r) => { if (!stopped) { setBoards(r.boards); onBoardsChangeRef.current?.(r.boards); } })
        .catch(() => { /* non-fatal — the original boards state keeps working */ });
    };
    loadContacts();

    // SSE live-sync: server pushes a one-line event whenever any user
    // (owner OR shared member) mutates the board. Replaces the 4s poll.
    // The server notifies types "contact" | "board" | "stages" | "dedup"
    // | "bulk" — we just refetch on any event. Stages/board events also
    // trigger a boards refresh since stages live on the board.
    const stream = new EventSource(`/api/crm/boards/${activeId}/stream`, { withCredentials: true });
    stream.onmessage = (ev) => {
      if (stopped) return;
      let type = "contact";
      try { type = (JSON.parse(ev.data) as { type?: string }).type ?? "contact"; } catch { /* malformed */ }
      loadContacts();
      if (type === "stages" || type === "board") loadBoards();
    };
    // Silent reconnect on transient error — EventSource auto-retries, but
    // we also fire a one-off refetch so the user isn't stuck on stale
    // state if the reconnect takes a few seconds.
    stream.onerror = () => { if (!stopped) loadContacts(); };

    // Slow safety-net polling — 30s backstop in case SSE is blocked by a
    // corporate proxy or the connection silently dies. Cheap enough to
    // leave on.
    const iv = window.setInterval(() => {
      if (document.visibilityState === "visible") { loadContacts(); loadBoards(); }
    }, 30_000);

    // Immediate refetch on tab refocus — users Alt-Tab to Slack and come
    // back expecting fresh data. SSE may already have pushed while
    // hidden, but refetching on focus is cheap insurance.
    const onFocus = () => { loadContacts(); loadBoards(); };
    const onVis = () => { if (document.visibilityState === "visible") { loadContacts(); loadBoards(); } };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);

    return () => {
      stopped = true;
      stream.close();
      window.clearInterval(iv);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [activeId]);

  const active = boards.find((b) => b.id === activeId);

  // Keep stages in sync with the server whenever the active board's
  // server-side stages change (e.g. the owner added a stage, our poll
  // returned the updated boards list). Fall back to localStorage/default
  // when the server doesn't have stages stored yet (legacy boards).
  const activeStagesKey = active?.stages ? JSON.stringify(active.stages) : "";
  useEffect(() => {
    if (!active) return;
    if (Array.isArray(active.stages) && active.stages.length > 0) {
      setStages(active.stages as StageDef[]);
      // Refresh localStorage cache so a quick remount before the next GET
      // keeps the same view.
      try { localStorage.setItem(stagesKey(active.id), JSON.stringify(active.stages)); } catch { /* noop */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, activeStagesKey]);

  // Keep the column schema in sync with the server. When the active board
  // first loads, if the server has no schema yet, migrate from localStorage
  // (or fall back to defaults) and persist back so collaborators see the
  // same columns. After that, every server push (SSE or 30s poll) replaces
  // the local schema in the same way as stages.
  const activeColumnsKey = active?.columns ? JSON.stringify(active.columns) : "null";
  useEffect(() => {
    if (!active) return;
    const raw = active.columns;
    if (Array.isArray(raw) && raw.length > 0) {
      const reconciled = reconcileColumns(raw as CrmColumnDef[]);
      setColumns(reconciled);
      // Push the reconciled schema back if we changed anything — added
      // missing defaults, dropped legacy built-ins, OR normalised a
      // structural column whose builtin/type got corrupted by an older
      // save. Length-only check missed the last case, which is what was
      // leaving Stage rendering as an empty dropdown.
      if (JSON.stringify(reconciled) !== JSON.stringify(raw)) {
        api.patch(`/api/crm/boards/${active.id}`, { columns: reconciled }).catch(() => { /* non-fatal */ });
      }
      return;
    }
    // No server-side schema yet — migrate from localStorage if present,
    // otherwise seed with defaults. Persist either way so collaborators
    // see the same starting view.
    const seed = migrateLegacyColumns(active.id) ?? defaultColumns();
    setColumns(seed);
    api.patch(`/api/crm/boards/${active.id}`, { columns: seed }).catch(() => { /* non-fatal */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, activeColumnsKey]);

  // Same idea for row height.
  useEffect(() => {
    if (!active) return;
    const rh = active.rowHeight;
    if (rh === "short" || rh === "medium" || rh === "tall") {
      setRowHeight(rh);
      cacheRowHeight(active.id, rh);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.rowHeight]);

  /** Persist the column schema to the server (and update local state
   *  optimistically). Collaborators receive the change via SSE within ~1s. */
  const saveColumns = async (next: CrmColumnDef[]) => {
    setColumns(next);
    try {
      await api.patch(`/api/crm/boards/${activeId}`, { columns: next });
    } catch (e) {
      onFlash(`Save columns failed: ${(e as Error).message}`);
    }
  };

  const saveRowHeight = async (next: CrmRowHeight) => {
    setRowHeight(next);
    if (activeId) cacheRowHeight(activeId, next);
    try {
      await api.patch(`/api/crm/boards/${activeId}`, { rowHeight: next });
    } catch { /* non-fatal — local state stays */ }
  };

  /** Persist the kanban stage list (rename/recolor/delete/add). Mirrors
   *  saveColumns — local cache + server PATCH so collaborators see it via
   *  SSE within ~1s. */
  const persistStages = (next: StageDef[]) => {
    setStages(next);
    if (activeId) saveStages(activeId, next);
  };

  /** Move every contact stuck in a deleted stage to a fallback stage,
   *  optimistically + via PATCH. Used when the kanban deletes a stage. */
  const reassignStage = async (fromId: string, toId: string) => {
    const affected = contacts.filter((c) => c.stage === fromId);
    setContacts((cs) => cs.map((c) => (c.stage === fromId ? { ...c, stage: toId as CrmStage } : c)));
    await Promise.all(affected.map((c) =>
      api.patch(`/api/crm/contacts/${c.id}`, { stage: toId }).catch(() => { /* non-fatal */ }),
    ));
  };

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
          <div className="view-toggle">
            <button className={viewMode === "kanban" ? "active" : ""} onClick={() => setViewMode("kanban")}>
              <IconList size={12} style={{ transform: "rotate(90deg)" }} />Board
            </button>
            <button className={viewMode === "table" ? "active" : ""} onClick={() => setViewMode("table")}>
              <IconSheet size={12} />Table
            </button>
          </div>
          {viewMode === "table" && (
            <RowHeightMenu value={rowHeight} onChange={saveRowHeight} />
          )}
        </div>
        <div className="crm-tools">
          <ActionsMenu>
            {(close) => (
              <>
                {/* Submenu components — keep Actions open so their nested
                    popovers can render on top. They don't call close(). */}
                {active && (
                  <BoardShareMenu
                    boardId={active.id}
                    boardName={active.name}
                    owned={active.owned !== false}
                    onFlash={onFlash}
                  />
                )}
                {viewMode === "kanban" && (
                  <KanbanFieldsMenu
                    boardId={activeId}
                    value={kanbanFields}
                    onChange={setKanbanFields}
                    customCols={customCols}
                  />
                )}
                {/* Direct actions — close Actions before (or alongside) their
                    state change so there's no overlap with the modal's
                    entrance animation. */}
                <button
                  className="pill-btn"
                  disabled={enriching}
                  onClick={() => { close(); enrichAll(); }}
                  title="Fill email for contacts that don't have one yet (via Apollo.io)"
                >
                  <IconMail size={12} />{enriching ? "Getting email…" : "Get email"}
                </button>
                <button
                  className="pill-btn"
                  disabled={backgrounding}
                  onClick={() => { close(); findBackgrounds(); }}
                  title="Research each contact on the web — posts, talks, notable things they've said — with inline source links"
                >
                  <IconSparkle size={12} />{backgrounding ? "Researching…" : "Find backgrounds"}
                </button>
                <button className="pill-btn" onClick={() => { close(); setImportOpen(true); }}>
                  <IconUpload size={12} />Import CSV
                </button>
                <button
                  className="pill-btn"
                  onClick={() => { close(); setCleanupOpen(true); }}
                  title="Upload a CSV from another CRM — any matching contacts will be removed from all your boards so you don't double-touch them"
                >
                  <IconClose size={12} />Remove from external CRM
                </button>
                <button className="pill-btn primary" onClick={() => { close(); setAddOpen(true); }}>
                  <IconNewChat size={12} />Add contact
                </button>
              </>
            )}
          </ActionsMenu>
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
          onStagesChange={persistStages}
          onReassign={reassignStage}
        />
      ) : (
        <TableView
          contacts={contacts}
          onOpen={setOpenContact}
          onPatch={patchContact}
          columns={columns}
          onColumnsChange={saveColumns}
          stages={stages}
          rowHeight={rowHeight}
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
          columns={columns}
          onColumnsChange={saveColumns}
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

