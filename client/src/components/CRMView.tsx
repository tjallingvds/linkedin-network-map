/**
 * CRM — multi-board pipeline (kanban + editable table), backed by the real
 * backend (`/api/crm/boards`, `/api/crm/boards/:id/contacts`, etc).
 *
 * Ported from design/project/CRMView.jsx. Board + contact state is persisted
 * server-side; the React tree just reflects it.
 */
import { Fragment, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type {
  CrmBoard, CrmContact, CrmImportRow, CrmStage, CrmTemp,
  CrmColumnDef, CrmColumnType, CrmRowHeight, CrmDropdownOption, CrmDocument, CrmAttachmentMeta,
} from "@app/shared";
import { api } from "../lib/api";
import { useModal } from "./Modal";
import { initials, avatarGrad } from "../design/mockProspects";
import {
  IconList, IconSheet, IconUpload, IconNewChat, IconClose, IconCheck, IconChevD, IconArrowR,
  IconSend, IconMail, IconSparkle, IconLinkedIn, IconUsers, IconSearch, IconFilter,
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
const REQUIRED_COLS: readonly string[] = ["person", "lastTouch"];

/** Minimal seed for a fresh board — Person (can't be removed), Stage
 *  (drives the kanban), and Last touch (manual sent/received logging
 *  that powers follow-up discipline). Every other column on the board
 *  is something the user adds explicitly from the "+" menu. The
 *  underlying DB still has fields for email/phone/linkedin/title/
 *  company/etc. — Apollo enrichment, CSV import, and the contact drawer
 *  all still use them — but they don't pollute the table by default. */
function defaultColumns(): CrmColumnDef[] {
  return [
    // Fixed-pixel default widths — using fr units made Person bloat to fill
    // the entire table whenever there were only a few columns, shoving
    // Stage far to the right and making them look unrelated.
    { id: "person",    builtin: true, label: "Person",     width: "240px", type: "person" },
    { id: "stage",     builtin: true, label: "Stage",      width: "140px", type: "stage" },
    { id: "lastTouch", builtin: true, label: "Last touch", width: "180px", type: "touch" },
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
function groupByCompanyKey(boardId: string) { return `crm.groupbycompany.v1.${boardId}`; }

function loadGroupByCompany(boardId: string): boolean {
  if (!boardId) return false;
  try { return localStorage.getItem(groupByCompanyKey(boardId)) === "1"; } catch { return false; }
}
function saveGroupByCompany(boardId: string, on: boolean) {
  if (!boardId) return;
  try {
    if (on) localStorage.setItem(groupByCompanyKey(boardId), "1");
    else localStorage.removeItem(groupByCompanyKey(boardId));
  } catch { /* noop */ }
}

// Legacy localStorage keys — read once on first load to migrate into the
// server-backed schema, then never touched again.
function legacyColsKey(boardId: string) { return `crm.cols.v1.${boardId}`; }
function legacyCustomColsKey(boardId: string) { return `crm.customcols.v1.${boardId}`; }

/** Kanban card fields are derived from the board's column schema —
 *  whatever the user has on their table is what the picker offers. By
 *  default new boards show no fields on the card (just the name); the
 *  user opts each column in via the Card fields menu. */
const KANBAN_DEFAULT: string[] = [];

function loadKanbanFields(boardId: string): string[] {
  if (!boardId) return KANBAN_DEFAULT;
  try {
    const raw = localStorage.getItem(kanbanFieldsKey(boardId));
    if (!raw) return KANBAN_DEFAULT;
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return KANBAN_DEFAULT;
    // Don't filter against valid column ids here — the schema may not be
    // loaded yet when this runs. The renderer / picker filter at use
    // time so a saved id pointing at a column that no longer exists is
    // simply ignored, not deleted.
    return (arr as string[]).filter((id) => typeof id === "string");
  } catch { return KANBAN_DEFAULT; }
}
function saveKanbanFields(boardId: string, ids: string[]) {
  if (!boardId) return;
  try { localStorage.setItem(kanbanFieldsKey(boardId), JSON.stringify(ids)); } catch { /* noop */ }
}

/** Default row height in pixels. Matches what used to be the "medium" preset. */
const DEFAULT_ROW_HEIGHT = 44;
/** Map any legacy enum string ("short" / "medium" / "tall") OR a number
 *  string back to a clamped px integer. Older boards stored the enum, so
 *  this lets them load without an explicit migration. */
function normaliseRowHeight(v: unknown): CrmRowHeight {
  if (typeof v === "number" && Number.isFinite(v)) return clampRowHeight(v);
  if (typeof v === "string") {
    if (v === "short")  return 32;
    if (v === "medium") return 44;
    if (v === "tall")   return 60;
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return clampRowHeight(n);
  }
  return DEFAULT_ROW_HEIGHT;
}
function clampRowHeight(n: number): CrmRowHeight {
  return Math.max(28, Math.min(200, Math.round(n)));
}

/** Read row height from localStorage as an instant first-paint cache. The
 *  server is the source of truth; this just stops the table from blinking
 *  on remount before the boards GET lands. */
function loadRowHeightCached(boardId: string): CrmRowHeight {
  if (!boardId) return DEFAULT_ROW_HEIGHT;
  try {
    const raw = localStorage.getItem(rowHeightKey(boardId));
    if (raw) return normaliseRowHeight(raw);
  } catch { /* noop */ }
  return DEFAULT_ROW_HEIGHT;
}
function cacheRowHeight(boardId: string, h: CrmRowHeight) {
  if (!boardId) return;
  try { localStorage.setItem(rowHeightKey(boardId), String(h)); } catch { /* noop */ }
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
  p, idx, onOpen, onDelete, onDragStart, onDragEnd, dragging, fields, columns,
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
  /** The board's full column schema — the card derives BOTH which fields
   *  exist AND how to render them from this. No hardcoded built-in list. */
  columns: CrmColumnDef[];
}) {
  const modal = useModal();
  const colById = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);

  /** Read the cell value for this contact + column. Built-in columns
   *  back real contact fields; everything else lives in customFields. */
  const readValue = (col: CrmColumnDef): string | null => {
    if (col.builtin) {
      switch (col.id) {
        case "title":        return p.title ?? null;
        case "company":      return p.company ?? null;
        case "email":        return p.email ?? null;
        case "phone":        return p.phone ?? null;
        case "linkedin":     return p.linkedin ?? null;
        case "temp":         return p.temp ?? null;
        case "nextStep":     return p.nextStep ?? null;
        case "source":       return p.source ?? null;
        case "messageNotes": return p.messageNotes ?? null;
        case "notes":        return p.notes ?? null;
        case "lastTouch":    return p.lastTouchAt ?? null;
        default:             return null;
      }
    }
    return (p.customFields ?? {})[col.id] ?? null;
  };

  const renderField = (id: string): React.ReactNode => {
    const col = colById.get(id);
    if (!col) return null;
    const raw = readValue(col);
    if (!raw) return null;

    const wrap = (value: React.ReactNode) => (
      <div key={id} className="kc-field">
        <span className="kc-field-label">{col.label}</span>
        <span className="kc-field-value">{value}</span>
      </div>
    );

    switch (col.type) {
      case "dropdown": {
        const opt = (col.options ?? []).find((o) => o.value === raw);
        const color = opt?.color ?? "oklch(0.7 0.04 280)";
        return wrap(
          <span className="tbl-stage" style={{ "--stage-color": color, "--stage-tint": tintFor(color) } as React.CSSProperties}>
            {raw}
          </span>,
        );
      }
      case "file": {
        try {
          const meta = JSON.parse(raw) as CrmAttachmentMeta;
          return wrap(<span className="page-chip">{meta.filename}</span>);
        } catch { return null; }
      }
      case "page": {
        const docs = p.documents ?? [];
        const doc = docs.find((d) => d.id === raw);
        if (!doc) return null;
        return wrap(<span className="page-chip">{doc.title || "Untitled"}</span>);
      }
      case "email":
        return wrap(<a href={`mailto:${raw}`} className="kc-link" onClick={(e) => e.stopPropagation()}>{raw}</a>);
      case "phone":
        return wrap(<a href={`tel:${raw.replace(/\s+/g, "")}`} className="kc-link" onClick={(e) => e.stopPropagation()}>{raw}</a>);
      case "link": {
        const display = raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
        const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
        return wrap(
          <a href={href} target="_blank" rel="noopener noreferrer" className="kc-link" onClick={(e) => e.stopPropagation()}>
            {display}
          </a>,
        );
      }
      case "date": {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
        return wrap(m ? `${m[3]}/${m[2]}/${m[1]}` : raw);
      }
      case "checkbox": {
        const on = raw === "true" || raw === "1" || raw === "yes";
        return wrap(<span style={{ color: on ? "var(--accent)" : "var(--text-mute)" }}>{on ? "✓ Yes" : "—"}</span>);
      }
      case "number":
        return wrap(<span style={{ fontFamily: "'Geist Mono', monospace", fontSize: 11 }}>{raw}</span>);
      case "longtext": {
        // Truncate to 2 lines on the card to keep the layout tidy.
        return wrap(<span className="kc-field-multi">{raw}</span>);
      }
      case "touch": {
        // raw is the ISO timestamp from readValue. Direction lives on
        // the contact directly — the card doesn't pass it through
        // readValue (which is string-only), so we read it here.
        const dir = p.lastTouchDirection;
        const rel = formatRelativeTime(raw);
        if (!rel) return null;
        const days = daysSince(raw) ?? 0;
        const stale = dir === "out" && days >= STALE_DAYS;
        return wrap(
          <span className={`kc-touch-pill${stale ? " kc-touch-stale" : ""}`}>
            <span className={`touch-arrow ${dir === "out" ? "touch-out-arrow" : "touch-in-arrow"}`}>
              {dir === "out" ? "↗" : "↘"}
            </span>
            {rel}
          </span>,
        );
      }
      default:
        return wrap(raw);
    }
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
  boardId, value, onChange, columns,
}: {
  boardId: string;
  value: string[];
  onChange: (next: string[]) => void;
  /** The board's full column schema — drives the picker so card-field
   *  options exactly match what the user has on their table. */
  columns: CrmColumnDef[];
}) {
  const [open, setOpen] = useState(false);
  // Person, Stage and the row-select column never appear on cards
  // (Person == card title, Stage == kanban column, _select is gone).
  // Hidden columns also drop out — the kanban shouldn't surface fields
  // the user has chosen to hide on the table.
  const cardOptions = columns.filter(
    (c) => !c.hidden && c.id !== "person" && c.id !== "stage" && c.id !== "_select",
  );
  const toggle = (id: string) => {
    const next = value.includes(id) ? value.filter((x) => x !== id) : [...value, id];
    onChange(next);
    saveKanbanFields(boardId, next);
  };
  const reset = () => {
    onChange([]);
    saveKanbanFields(boardId, []);
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
            <div className="bm-label">Show on cards</div>
            {cardOptions.length === 0 ? (
              <div style={{ padding: "8px 10px", fontSize: 11.5, color: "var(--text-mute)" }}>
                Add columns to your table — they'll appear here.
              </div>
            ) : cardOptions.map((c) => {
              const on = value.includes(c.id);
              return (
                <button key={c.id} className="bm-item" onClick={() => toggle(c.id)}>
                  <ColCheckbox on={on} />
                  <span style={{ flex: 1, textAlign: "left" }}>{c.label}</span>
                </button>
              );
            })}
            {value.length > 0 && (
              <>
                <div className="bm-sep" />
                <button className="bm-item" onClick={reset}>
                  <IconArrowR size={13} /><span>Hide all</span>
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Dropdown that filters the table to a subset of stages. An empty
 *  selection means "all stages" (no filter). Mirrors the kanban columns
 *  as a multi-select so the table can be narrowed the same way the board
 *  is read column-by-column. */
function StageFilterMenu({
  stages, value, onChange,
}: {
  stages: StageDef[];
  value: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const toggle = (id: string) => {
    const next = new Set(value);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(next);
  };
  const active = value.size > 0;
  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        className={`pill-btn${active ? " primary" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title="Filter rows by stage"
      >
        <IconFilter size={12} />
        {active ? `Filters (${value.size})` : "Filters"}
      </button>
      {open && (
        <>
          <div className="board-menu-bg" onClick={() => setOpen(false)} />
          <div className="board-menu" style={{ minWidth: 200, left: 0, right: "auto" }}>
            <div className="bm-label">Show stages</div>
            {stages.map((s) => {
              const on = value.has(s.id);
              return (
                <button key={s.id} className="bm-item" onClick={() => toggle(s.id)}>
                  <ColCheckbox on={on} />
                  <span
                    className="tbl-stage"
                    style={{ "--stage-color": s.color, "--stage-tint": s.tint, flex: 1, textAlign: "left" } as React.CSSProperties}
                  >
                    {s.label}
                  </span>
                </button>
              );
            })}
            {active && (
              <>
                <div className="bm-sep" />
                <button className="bm-item" onClick={() => onChange(new Set())}>
                  <IconArrowR size={13} /><span>Show all</span>
                </button>
              </>
            )}
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
  onDragStart, onDragEnd,
}: {
  stage: StageDef;
  count: number;
  isFirst: boolean;
  isOnly: boolean;
  onRename: (label: string) => void;
  onCycleColor: () => void;
  onDelete: () => void;
  /** Drag handlers for stage-reorder (the head bar is the handle). */
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
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
    <div
      className="kanban-head"
      // Grab the header to drag-reorder the whole stage. Buttons / inputs
      // inside don't fire dragstart, so rename + delete + color cycle
      // still work.
      draggable={!editing}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <button
        className="kanban-bar kanban-bar-btn"
        title="Cycle color"
        onClick={onCycleColor}
        draggable={false}
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
          title="Drag to reorder · Double-click to rename"
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
          draggable={false}
        >
          <IconClose size={11} />
        </button>
      )}
    </div>
  );
}

function KanbanBoard({
  contacts, onOpen, onMoveStage, onDelete, fields, columns, stages,
  onStagesChange, onReassign,
}: {
  contacts: CrmContact[];
  onOpen: (c: CrmContact) => void;
  onMoveStage: (contactId: string, stage: CrmStage) => void;
  onDelete: (id: string) => void;
  fields: string[];
  /** Full board column schema — passed through to each card so the
   *  fields rendered match the table exactly. */
  columns: CrmColumnDef[];
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

  // Stage drag-reorder. Uses a separate MIME type so the existing
  // contact-card drag (text/plain = contact id) doesn't collide with
  // stage drag (text/x-stage-id). Drop-edge is left/right of the column.
  const [draggingStageId, setDraggingStageId] = useState<string | null>(null);
  const [stageDropTarget, setStageDropTarget] = useState<{ id: string; edge: "left" | "right" } | null>(null);

  const reorderStages = (sourceId: string, targetId: string, edge: "left" | "right") => {
    if (sourceId === targetId) return;
    const next = list.slice();
    const sourceIdx = next.findIndex((s) => s.id === sourceId);
    if (sourceIdx < 0) return;
    const [moved] = next.splice(sourceIdx, 1);
    if (!moved) return;
    let insertAt = next.findIndex((s) => s.id === targetId);
    if (edge === "right") insertAt += 1;
    if (insertAt < 0) insertAt = next.length;
    next.splice(insertAt, 0, moved);
    onStagesChange(next);
  };

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
        const stageDropEdge = stageDropTarget?.id === stage.id ? stageDropTarget.edge : null;
        return (
          <div
            key={stage.id}
            className={`kanban-col${isOver ? " drag-over" : ""}${stageDropEdge ? ` stage-drop-${stageDropEdge}` : ""}`}
            style={{ "--stage-tint": stage.tint, "--stage-color": stage.color } as React.CSSProperties}
            onDragOver={(e) => {
              // Two drag flavours can land here: a contact-card drag (text/plain)
              // and a stage-reorder drag (text/x-stage-id). Stage drag wins —
              // it sets stageDropTarget; card drag highlights the column.
              if (draggingStageId && draggingStageId !== stage.id) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const edge = e.clientX < rect.left + rect.width / 2 ? "left" : "right";
                setStageDropTarget((cur) => (cur?.id === stage.id && cur.edge === edge ? cur : { id: stage.id, edge }));
                return;
              }
              if (!draggingId) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (overStage !== stage.id) setOverStage(stage.id);
            }}
            onDragLeave={() => { if (overStage === stage.id) setOverStage(null); }}
            onDrop={(e) => {
              e.preventDefault();
              if (draggingStageId) {
                if (stageDropTarget) reorderStages(draggingStageId, stageDropTarget.id, stageDropTarget.edge);
                setDraggingStageId(null);
                setStageDropTarget(null);
                return;
              }
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
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/x-stage-id", stage.id);
                setDraggingStageId(stage.id);
              }}
              onDragEnd={() => { setDraggingStageId(null); setStageDropTarget(null); }}
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
                  columns={columns}
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
                columns={columns}
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
  // Single click anywhere in the cell starts editing — clicking on
  // the value is meant to be a "select to change" gesture, not "open
  // in new tab". The small ↗ icon next to the text is the affordance
  // for actually opening the URL.
  return (
    <span
      className="ed-cell"
      onClick={(e) => { e.stopPropagation(); setEditing(true); }}
      style={{ width: "100%", display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}
      title="Click to edit"
    >
      <span style={{ color: "var(--accent)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
        {display}
      </span>
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        title="Open"
        onClick={(e) => e.stopPropagation()}
        style={{ color: "var(--text-mute)", flex: "0 0 auto", display: "inline-flex" }}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 3h3v3" />
          <path d="M13 3l-7 7" />
          <path d="M12 9v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
        </svg>
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
  page: "Page",
  file: "File",
  stage: "Stage",
  temp: "Temp",
  person: "Person",
  touch: "Last touch",
  select: "Select",
};

/** Types the user can pick when adding a custom column or changing one's type.
 *  Built-in types like "stage", "temp", "person", "select" are excluded — those
 *  are reserved for built-in columns and have specialized rendering. */
const USER_PICKABLE_TYPES: CrmColumnType[] = [
  "text", "longtext", "number", "dropdown", "email", "phone", "link", "date", "checkbox", "page", "file",
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

/** Page-column cell. The cell stores a document id pointing into the
 *  contact's `documents` array. Clicking opens that page in the focused
 *  Notion-style editor. Empty cells spin up a fresh doc, link it, and
 *  open it in one go. */
function PageCellEditor({
  value, documents, onCreateLinked, onOpenExisting,
}: {
  value: string | null | undefined;
  documents: CrmDocument[];
  /** Create a new doc, store its id as this cell's value, open it. */
  onCreateLinked: () => void;
  /** Open an already-linked doc in the editor. */
  onOpenExisting: (docId: string) => void;
}) {
  const doc = value ? documents.find((d) => d.id === value) : null;
  const open = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (doc) onOpenExisting(doc.id);
    else onCreateLinked();
  };
  return (
    <span className="ed-cell page-cell" onClick={open}>
      {doc ? (
        <span className="page-chip">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "0 0 11px" }}>
            <path d="M3 2h6l4 4v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
            <path d="M9 2v4h4" />
          </svg>
          <span className="page-chip-title">{doc.title || "Untitled"}</span>
        </span>
      ) : (
        <span className="page-empty">+ Open page</span>
      )}
    </span>
  );
}

/** File-column cell. The cell value is JSON-stringified
 *  CrmAttachmentMeta — { id, filename, mime, size }. Click an empty
 *  cell to upload, click a filled chip to open the file in a new tab,
 *  hover the chip to reveal an X that detaches the file. */
function FileCellEditor({
  value, contactId, onSave,
}: {
  value: string | null | undefined;
  contactId: string;
  onSave: (v: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  let meta: CrmAttachmentMeta | null = null;
  if (value) {
    try { meta = JSON.parse(value) as CrmAttachmentMeta; }
    catch { meta = null; }
  }

  const upload = async (file: File) => {
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/crm/contacts/${contactId}/attachments`, {
        method: "POST", body: fd, credentials: "include",
      });
      if (!res.ok) throw new Error(`upload failed: ${res.status}`);
      const json = (await res.json()) as CrmAttachmentMeta;
      onSave(JSON.stringify(json));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const detach = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!meta) return;
    onSave("");
    // Best-effort delete on the server — non-fatal if it 404s.
    fetch(`/api/crm/attachments/${meta.id}`, { method: "DELETE", credentials: "include" }).catch(() => undefined);
  };

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (meta) {
      window.open(`/api/crm/attachments/${meta.id}`, "_blank", "noopener,noreferrer");
      return;
    }
    inputRef.current?.click();
  };

  const sizeLabel = meta ? formatFileSize(meta.size) : "";

  return (
    <span className="ed-cell file-cell" onClick={onClick} title={meta ? meta.filename : "Upload a file"}>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,image/*,.doc,.docx,.txt,.md,.csv,.xlsx"
        style={{ display: "none" }}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.currentTarget.value = ""; }}
      />
      {busy ? (
        <span className="file-empty">Uploading…</span>
      ) : meta ? (
        <span className="file-chip">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "0 0 11px" }}>
            <path d="M4 2h6l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
            <path d="M10 2v3h3" />
          </svg>
          <span className="file-chip-title">{meta.filename}</span>
          <span className="file-chip-size">{sizeLabel}</span>
          <button className="file-chip-x" onClick={detach} title="Remove file">
            <IconClose size={9} />
          </button>
        </span>
      ) : error ? (
        <span className="file-empty" style={{ color: "var(--danger, oklch(0.55 0.2 25))" }}>
          Upload failed — click to retry
        </span>
      ) : (
        <span className="file-empty">+ Upload file</span>
      )}
    </span>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

/** Next-step cell — the promise text plus a hard deadline date.
 *  Both edit independently and patch back together; the deadline
 *  surfaces in the Overview "Deadlines" section so the user
 *  doesn't have to scan the table for things they owe. */
function NextStepCell({
  text, dueAt, onChange,
}: {
  text: string | null | undefined;
  dueAt: string | null | undefined;
  onChange: (patch: { nextStep?: string | null; nextStepDueAt?: string | null }) => void;
}) {
  const [editingText, setEditingText] = useState(false);
  const [editingDate, setEditingDate] = useState(false);
  const textRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editingText) textRef.current?.focus(); }, [editingText]);
  useEffect(() => { if (editingDate) dateRef.current?.focus(); }, [editingDate]);

  // Overdue / due-soon tint on the date pill — same urgency cues as
  // the Overview timer so the table reads at a glance.
  const dueClass = (() => {
    if (!dueAt) return "";
    const d = new Date(dueAt).getTime();
    if (!Number.isFinite(d)) return "";
    const ms = d - Date.now();
    if (ms < 0) return "nx-due-overdue";
    if (ms < 2 * 86_400_000) return "nx-due-soon";
    return "";
  })();
  const dueDisplay = dueAt ? formatDateDisplay(dueAt) : "";

  return (
    <div className="nx-cell" onClick={(e) => e.stopPropagation()}>
      {editingText ? (
        <input
          ref={textRef}
          type="text"
          className="ed-input nx-text-input"
          defaultValue={text ?? ""}
          placeholder="Promise / next step"
          onBlur={(e) => {
            setEditingText(false);
            if (e.target.value !== (text ?? "")) onChange({ nextStep: e.target.value || null });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setEditingText(false);
          }}
        />
      ) : (
        <span
          className="nx-text"
          onClick={(e) => { e.stopPropagation(); setEditingText(true); }}
        >
          {text || <em style={{ color: "var(--text-mute)" }}>+ promise</em>}
        </span>
      )}
      {editingDate ? (
        <input
          ref={dateRef}
          type="date"
          className="ed-input nx-date-input"
          defaultValue={dueAt ? dueAt.slice(0, 10) : ""}
          onBlur={(e) => {
            setEditingDate(false);
            // Normalize to noon UTC so the date doesn't drift across timezones.
            const next = e.target.value ? new Date(`${e.target.value}T12:00:00Z`).toISOString() : null;
            if (next !== (dueAt ?? null)) onChange({ nextStepDueAt: next });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setEditingDate(false);
          }}
        />
      ) : (
        <button
          type="button"
          className={`nx-due ${dueClass}`}
          onClick={() => setEditingDate(true)}
          title={dueAt ? `Due ${dueDisplay} — click to change` : "Set deadline"}
        >
          {dueAt ? `📅 ${dueDisplay}` : "📅 set"}
        </button>
      )}
    </div>
  );
}

function formatDateDisplay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** "5d ago" / "3h ago" / "just now" — used by the touch cell so the
 *  follow-up signal is readable at a glance without parsing a date. */
function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diffMs = Date.now() - t;
  if (diffMs < 60_000) return "just now";
  const min = Math.round(diffMs / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

/** Days since the given ISO timestamp. Returns null for null/invalid. */
function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

/** Hours since the given ISO timestamp. Returns null for null/invalid.
 *  Used by Overview's "open messages" timer so threshold + label match
 *  at hour precision — "9h waiting" is more actionable than "<1d". */
function hoursSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 3_600_000);
}

/** Threshold (in days) past which an unreplied outbound counts as stale.
 *  Surfaces the "needs follow-up" cue on the row + the Companies rollup. */
const STALE_DAYS = 5;

/** Aggregate roll-up of one company's contacts — feeds the
 *  "Group by company" table header row + sort order. */
interface CompanyGroup {
  /** Normalized lowercase company name. `__uncat__` for blank company. */
  key: string;
  label: string;
  contacts: CrmContact[];
  /** Newest touch across every contact in this group. */
  lastTouchAt: string | null;
  lastTouchDirection: "in" | "out" | null;
  /** Index of the warmest stage in the board's stages array. -1 if no one
   *  has a known stage (every contact's stage id is missing from the
   *  board's stages list). */
  warmestStageIdx: number;
  warmestStageLabel: string | null;
  warmestStageColor: string | null;
  /** Any contact has an unanswered outbound > STALE_DAYS old. */
  isStale: boolean;
}

/** Resolve a contact's company name, preferring a user-added "Company"
 *  custom column when present. The built-in `c.company` field is the
 *  fallback — it's where CSV imports + Apollo enrichment write, but a
 *  user maintaining their own custom column expects that column's value
 *  to be authoritative for grouping. */
function readCompany(c: CrmContact, customCompanyColId: string | null): string {
  if (customCompanyColId) {
    const v = (c.customFields ?? {})[customCompanyColId];
    if (v && v.trim()) return v.trim();
  }
  return (c.company ?? "").trim();
}

function findCompanyColumnId(columns: CrmColumnDef[]): string | null {
  // Case-insensitive exact match on a non-builtin column labelled "Company".
  // Only the user's own column wins — built-ins / required cols don't qualify.
  const col = columns.find(
    (c) => !c.builtin && (c.label ?? "").trim().toLowerCase() === "company",
  );
  return col ? col.id : null;
}

function computeCompanyGroups(
  contacts: CrmContact[],
  stages: StageDef[],
  columns: CrmColumnDef[],
): CompanyGroup[] {
  const stageIdxById = new Map(stages.map((s, i) => [s.id, i] as const));
  const customCompanyColId = findCompanyColumnId(columns);
  const groups = new Map<string, CrmContact[]>();
  // Keep the original casing of the first contact in a group as the
  // display label — we lower-case only for the grouping key.
  const displayLabel = new Map<string, string>();
  for (const c of contacts) {
    const raw = readCompany(c, customCompanyColId);
    const key = raw ? raw.toLowerCase() : "__uncat__";
    const arr = groups.get(key);
    if (arr) arr.push(c); else {
      groups.set(key, [c]);
      if (raw) displayLabel.set(key, raw);
    }
  }
  const result: CompanyGroup[] = [];
  for (const [key, list] of groups.entries()) {
    let lastTouchAt: string | null = null;
    let lastTouchDirection: "in" | "out" | null = null;
    let warmestIdx = -1;
    let isStale = false;
    for (const c of list) {
      if (c.lastTouchAt) {
        if (!lastTouchAt || new Date(c.lastTouchAt).getTime() > new Date(lastTouchAt).getTime()) {
          lastTouchAt = c.lastTouchAt;
          lastTouchDirection = c.lastTouchDirection;
        }
      }
      const idx = stageIdxById.get(c.stage) ?? -1;
      if (idx > warmestIdx) warmestIdx = idx;
      if (c.lastTouchDirection === "out" && c.lastTouchAt) {
        const d = daysSince(c.lastTouchAt);
        if (d != null && d >= STALE_DAYS) isStale = true;
      }
    }
    const label = key === "__uncat__"
      ? "Uncategorized"
      : (displayLabel.get(key) || "Uncategorized");
    const warm = warmestIdx >= 0 ? stages[warmestIdx] : null;
    result.push({
      key, label, contacts: list,
      lastTouchAt, lastTouchDirection,
      warmestStageIdx: warmestIdx,
      warmestStageLabel: warm?.label ?? null,
      warmestStageColor: warm?.color ?? null,
      isStale,
    });
  }
  // Sort priority — stale first (most actionable), then warmest stage
  // (closer to closed first), then alphabetical. Uncategorized always last
  // because it's where blank-company contacts land — not a real cohort.
  result.sort((a, b) => {
    if (a.key === "__uncat__") return 1;
    if (b.key === "__uncat__") return -1;
    if (a.isStale !== b.isStale) return a.isStale ? -1 : 1;
    if (a.warmestStageIdx !== b.warmestStageIdx) return b.warmestStageIdx - a.warmestStageIdx;
    return a.label.localeCompare(b.label);
  });
  return result;
}

/** Touch cell — one-click "Sent" / "Received" buttons when empty;
 *  relative time + direction arrow when set, with a popover to update
 *  (re-stamp now, or backdate via a date input, or clear). */
function TouchCell({
  at, direction, onChange,
}: {
  at: string | null;
  direction: "in" | "out" | null;
  onChange: (patch: { lastTouchAt: string | null; lastTouchDirection: "in" | "out" | null }) => void;
}) {
  const [open, setOpen] = useState(false);
  const stamp = (dir: "in" | "out") => {
    onChange({ lastTouchAt: new Date().toISOString(), lastTouchDirection: dir });
    setOpen(false);
  };
  const backdate = (dateStr: string, dir: "in" | "out") => {
    if (!dateStr) return;
    // Normalize "YYYY-MM-DD" to noon UTC so it doesn't drift across timezones.
    const iso = new Date(`${dateStr}T12:00:00Z`).toISOString();
    onChange({ lastTouchAt: iso, lastTouchDirection: dir });
    setOpen(false);
  };
  const clear = () => {
    onChange({ lastTouchAt: null, lastTouchDirection: null });
    setOpen(false);
  };

  // Empty state — just the two stamp buttons, single-click logs.
  if (!at || !direction) {
    return (
      <div className="touch-cell" onClick={(e) => e.stopPropagation()}>
        <button className="touch-btn touch-out" onClick={() => stamp("out")} title="Log Sent now">
          <span className="touch-arrow">↗</span>Sent
        </button>
        <button className="touch-btn touch-in" onClick={() => stamp("in")} title="Log Received now">
          <span className="touch-arrow">↘</span>Received
        </button>
      </div>
    );
  }

  // Touched state — keep the two stamp buttons surfaced as one-click
  // re-log actions (clicking either updates the timestamp + direction
  // immediately). The relative-time pill stays as the surface for
  // advanced ops (backdate / clear) via the popover.
  const days = daysSince(at) ?? 0;
  const stale = direction === "out" && days >= STALE_DAYS;
  const relTime = formatRelativeTime(at);
  return (
    <div className="touch-cell touch-cell-filled" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`touch-display${stale ? " touch-stale" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title={`Last touch: ${relTime} (${direction === "out" ? "you sent" : "you received"}) — click for backdate / clear`}
      >
        <span className={`touch-arrow ${direction === "out" ? "touch-out-arrow" : "touch-in-arrow"}`}>
          {direction === "out" ? "↗" : "↘"}
        </span>
        <span className="touch-text">{relTime}</span>
        {stale && <span className="touch-stale-dot" aria-label="needs follow-up" />}
      </button>
      <button
        type="button"
        className="touch-btn touch-btn-mini touch-out"
        onClick={() => stamp("out")}
        title="Log Sent now"
        aria-label="Log Sent now"
      >
        <span className="touch-arrow">↗</span>
      </button>
      <button
        type="button"
        className="touch-btn touch-btn-mini touch-in"
        onClick={() => stamp("in")}
        title="Log Received now"
        aria-label="Log Received now"
      >
        <span className="touch-arrow">↘</span>
      </button>
      {open && (
        <>
          <div className="board-menu-bg" onClick={() => setOpen(false)} />
          <div className="board-menu touch-menu">
            <div className="bm-label">Backdate</div>
            <div className="touch-backdate">
              <input
                type="date"
                className="ed-input"
                defaultValue={at.slice(0, 10)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  // Direction stays whatever it currently is.
                  if (e.target.value) backdate(e.target.value, direction);
                }}
              />
            </div>
            <div className="bm-sep" />
            <button className="bm-item" onClick={clear}>
              <IconClose size={11} /><span>Clear</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** "Overview" view — surfaces two attention-needed buckets from the
 *  user's pipeline so they don't have to scan the whole table:
 *    - "Open messages": every inbound touch (you received) the user
 *      hasn't responded to. No time threshold — incoming messages
 *      are always actionable. Each row carries a "Xm / Xh / Xd
 *      waiting" timer that prefers minute precision under an hour.
 *    - "Follow up":     outbound touches ≥ 4 days old. Threshold is
 *      purely time-based; we don't try to filter by stage because
 *      "I sent it, no reply, time to nudge" is the universal signal
 *      regardless of where the contact sits in the pipeline.
 *  Each row exposes the same single-click Sent / Received stamps so
 *  the user can act + clear the row inline. */
const OVERVIEW_FOLLOWUP_DAYS = 4;

function OverviewView({
  contacts, onOpen, onPatch, stages,
}: {
  contacts: CrmContact[];
  onOpen: (c: CrmContact) => void;
  onPatch: (id: string, patch: Partial<CrmContact>) => void;
  stages: StageDef[];
}) {
  // Inline "add deadline" form state — picker + promise + date. Kept
  // local to Overview so the section is the one place to manage every
  // deadline (no need to hunt for the contact in the table first).
  const [addOpen, setAddOpen] = useState(false);
  const [addContactId, setAddContactId] = useState<string>("");
  const [addText, setAddText] = useState("");
  const [addDueAt, setAddDueAt] = useState("");
  const [addQuery, setAddQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  const selectedAddContact = useMemo(
    () => contacts.find((c) => c.id === addContactId) ?? null,
    [contacts, addContactId],
  );

  const pickerMatches = useMemo(() => {
    const q = addQuery.trim().toLowerCase();
    const base = q
      ? contacts.filter((c) =>
          [c.name, c.title, c.company, c.email].some((v) => (v ?? "").toLowerCase().includes(q)),
        )
      : contacts;
    return base.slice(0, 12);
  }, [contacts, addQuery]);

  const resetAddForm = () => {
    setAddOpen(false);
    setAddContactId("");
    setAddText("");
    setAddDueAt("");
    setAddQuery("");
    setPickerOpen(false);
  };

  const saveNewDeadline = () => {
    if (!addContactId || (!addText.trim() && !addDueAt)) return;
    onPatch(addContactId, {
      nextStep: addText.trim() || null,
      // Same noon-UTC normalization as TouchCell's backdate input.
      nextStepDueAt: addDueAt ? new Date(`${addDueAt}T12:00:00Z`).toISOString() : null,
    });
    resetAddForm();
  };

  const { needsReply, followUp, deadlines } = useMemo(() => {
    // Stages whose name marks a lead as dead or parked ("Cold",
    // "Replied Then Ignored", …). People sitting in those columns shouldn't
    // be nudged, so they're excluded from the whole overview.
    const excludedStageIds = new Set(
      stages.filter((s) => /cold|ignored/i.test(s.label ?? "")).map((s) => s.id),
    );
    const needsReply: CrmContact[] = [];
    const followUp: CrmContact[] = [];
    const deadlines: CrmContact[] = [];
    for (const c of contacts) {
      if (excludedStageIds.has(c.stage)) continue;
      const h = hoursSince(c.lastTouchAt);
      // Inbound — always surface. The user wants to see every message
      // waiting on a reply, no matter how recently it arrived.
      if (h != null && c.lastTouchDirection === "in") {
        needsReply.push(c);
      } else if (
        h != null &&
        c.lastTouchDirection === "out" &&
        h >= OVERVIEW_FOLLOWUP_DAYS * 24
      ) {
        followUp.push(c);
      }
      // Hard deadlines are independent of touch state — a promise is a
      // promise whether the conversation is hot or cold.
      if (c.nextStepDueAt) deadlines.push(c);
    }
    // Oldest first for touch buckets — most stale work surfaces at top.
    const byStaleness = (a: CrmContact, b: CrmContact) =>
      (new Date(a.lastTouchAt ?? 0).getTime()) - (new Date(b.lastTouchAt ?? 0).getTime());
    // Deadlines sort soonest-first (overdue → today → next week → later).
    const byDueAt = (a: CrmContact, b: CrmContact) =>
      (new Date(a.nextStepDueAt ?? 0).getTime()) - (new Date(b.nextStepDueAt ?? 0).getTime());
    needsReply.sort(byStaleness);
    followUp.sort(byStaleness);
    deadlines.sort(byDueAt);
    return { needsReply, followUp, deadlines };
  }, [contacts, stages]);

  const stageById = useMemo(() => {
    const m = new Map<string, StageDef>();
    for (const s of stages) m.set(s.id, s);
    return m;
  }, [stages]);

  const renderRow = (c: CrmContact, idx: number) => {
    const stage = stageById.get(c.stage);
    const ms = c.lastTouchAt ? Date.now() - new Date(c.lastTouchAt).getTime() : 0;
    const minutes = Math.max(0, Math.floor(ms / 60_000));
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    // Pick the unit that fits the bucket:
    //   inbound → minutes / hours / days  (we surface immediately, so
    //     sub-hour items need fine precision)
    //   outbound → days only  (Follow up only includes rows ≥ 4 days
    //     old, so anything finer is noise)
    const durationLabel = c.lastTouchDirection === "in"
      ? (minutes < 60 ? `${minutes}m` : hours < 48 ? `${hours}h` : `${days}d`)
      : `${days}d`;
    // Verb depends on direction:
    //   inbound  → "X waiting"      (they sent, the user owes a reply)
    //   outbound → "no reply for X" (the user sent, they went silent)
    const timerLabel = c.lastTouchDirection === "in"
      ? `${durationLabel} waiting`
      : `no reply for ${durationLabel}`;
    // Urgency tint scales with wait time. Warm at 8h+, hot at 24h+.
    const urgencyClass = hours >= 24 ? "ov-timer-hot" : hours >= 8 ? "ov-timer-warm" : "";
    return (
      <div key={c.id} className="ov-row" onClick={() => onOpen(c)}>
        <div className="ov-avatar" style={{ background: avatarGrad(c.positionIdx ?? idx) }}>
          {initials(c.name)}
        </div>
        <div className="ov-meta">
          <div className="ov-name">{c.name || "Unnamed"}</div>
          <div className="ov-sub">
            {[c.title, c.company].filter(Boolean).join(" · ") || "—"}
          </div>
        </div>
        <span
          className={`ov-timer ${urgencyClass}`}
          title={
            c.lastTouchDirection === "in"
              ? `Received ${durationLabel} ago`
              : `Sent ${durationLabel} ago`
          }
        >
          ⏱ {timerLabel}
        </span>
        {stage && (
          <span
            className="ov-stage-chip"
            style={{ background: stage.tint, color: stage.color, borderColor: stage.color }}
          >
            {stage.label}
          </span>
        )}
        <div className="ov-touch" onClick={(e) => e.stopPropagation()}>
          <TouchCell
            at={c.lastTouchAt}
            direction={c.lastTouchDirection}
            onChange={(patch) => onPatch(c.id, patch)}
          />
        </div>
      </div>
    );
  };

  const renderDeadlineRow = (c: CrmContact, idx: number) => {
    const dueMs = c.nextStepDueAt ? new Date(c.nextStepDueAt).getTime() : 0;
    const diffMs = dueMs - Date.now();
    const diffDays = Math.round(diffMs / 86_400_000);
    let chip = "";
    let chipClass = "ov-timer";
    if (diffMs < 0) {
      // Overdue — count days late, capped at 90 for layout.
      const late = Math.min(90, Math.abs(diffDays));
      chip = late === 0 ? "Overdue today" : `Overdue ${late}d`;
      chipClass = "ov-timer ov-timer-hot";
    } else if (diffDays === 0) {
      chip = "Due today";
      chipClass = "ov-timer ov-timer-warm";
    } else if (diffDays <= 2) {
      chip = `Due in ${diffDays}d`;
      chipClass = "ov-timer ov-timer-warm";
    } else {
      chip = `Due in ${diffDays}d`;
    }
    return (
      <div key={c.id} className="ov-row ov-row-deadline">
        <div
          className="ov-avatar"
          style={{ background: avatarGrad(c.positionIdx ?? idx), cursor: "pointer" }}
          onClick={() => onOpen(c)}
          title="Open contact"
        >
          {initials(c.name)}
        </div>
        <div className="ov-meta">
          <div
            className="ov-name"
            onClick={() => onOpen(c)}
            style={{ cursor: "pointer" }}
            title="Open contact"
          >
            {c.name || "Unnamed"}
          </div>
          {/* Inline-editable promise + date — the Overview is the one
              place to manage deadlines without bouncing to the table. */}
          <div className="ov-promise-row" onClick={(e) => e.stopPropagation()}>
            <NextStepCell
              text={c.nextStep}
              dueAt={c.nextStepDueAt}
              onChange={(patch) => onPatch(c.id, patch)}
            />
          </div>
        </div>
        <span className={chipClass} title={c.nextStepDueAt ? `Due ${formatDateDisplay(c.nextStepDueAt)}` : ""}>
          ⏰ {chip}
        </span>
        <button
          type="button"
          className="ov-done"
          onClick={(e) => {
            e.stopPropagation();
            // Mark done: clear both the promise text and the due date.
            // (Cheap MVP — no separate "completed" log. The user can
            //  re-add it if needed.)
            onPatch(c.id, { nextStep: null, nextStepDueAt: null });
          }}
          title="Mark as done — clears the promise + deadline"
          aria-label="Mark done"
        >
          ✓ Done
        </button>
      </div>
    );
  };

  return (
    <div className="ov-wrap">
      {/* Deadlines first — hard promises trump anything else. */}
      <section className="ov-section">
        <header className="ov-head">
          <h3 className="ov-title">Deadlines</h3>
          <span className="ov-count">{deadlines.length}</span>
          <span className="ov-hint">
            Promises with a hard date. Overdue first, then by due date.
          </span>
          <button
            type="button"
            className="pill-btn primary ov-add-btn"
            onClick={() => setAddOpen((v) => !v)}
            title="Add a new deadline"
          >
            <IconNewChat size={11} />
            {addOpen ? "Close" : "Add deadline"}
          </button>
        </header>
        {addOpen && (
          <div className="ov-add-form">
            {/* Contact picker — searchable. Picks from the same set the
                buckets render so the user's network filter applies
                uniformly. */}
            <div className="ov-add-picker">
              {selectedAddContact ? (
                <div className="ov-add-chip">
                  <div
                    className="ov-avatar"
                    style={{ background: avatarGrad(selectedAddContact.positionIdx ?? 0), width: 22, height: 22, fontSize: 9 }}
                  >
                    {initials(selectedAddContact.name)}
                  </div>
                  <span>{selectedAddContact.name}</span>
                  <button
                    type="button"
                    className="ov-add-clear"
                    onClick={() => { setAddContactId(""); setAddQuery(""); setPickerOpen(true); }}
                    aria-label="Change contact"
                  >
                    <IconClose size={10} />
                  </button>
                </div>
              ) : (
                <div className="ov-add-search">
                  <input
                    type="text"
                    className="ed-input"
                    placeholder="Find a contact…"
                    value={addQuery}
                    onChange={(e) => { setAddQuery(e.target.value); setPickerOpen(true); }}
                    onFocus={() => setPickerOpen(true)}
                    autoFocus
                  />
                  {pickerOpen && pickerMatches.length > 0 && (
                    <>
                      <div className="board-menu-bg" onClick={() => setPickerOpen(false)} />
                      <div className="board-menu ov-add-results">
                        {pickerMatches.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            className="bm-item ov-add-result"
                            onClick={() => {
                              setAddContactId(c.id);
                              setAddQuery("");
                              setPickerOpen(false);
                              // Pre-fill from existing values so an edit-add
                              // flow is one click + tweak.
                              setAddText(c.nextStep ?? "");
                              setAddDueAt(c.nextStepDueAt ? c.nextStepDueAt.slice(0, 10) : "");
                            }}
                          >
                            <div
                              className="ov-avatar"
                              style={{ background: avatarGrad(c.positionIdx ?? 0), width: 22, height: 22, fontSize: 9 }}
                            >
                              {initials(c.name)}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12.5, color: "var(--text)" }}>{c.name || "Unnamed"}</div>
                              <div style={{ fontSize: 11, color: "var(--text-mute)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {[c.title, c.company].filter(Boolean).join(" · ") || "—"}
                              </div>
                            </div>
                            {c.nextStepDueAt && (
                              <span className="ov-timer" style={{ fontSize: 10 }}>
                                has deadline
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
            <input
              type="text"
              className="ed-input ov-add-text"
              placeholder="What did you promise?"
              value={addText}
              onChange={(e) => setAddText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveNewDeadline(); }}
            />
            <input
              type="date"
              className="ed-input ov-add-date"
              value={addDueAt}
              onChange={(e) => setAddDueAt(e.target.value)}
            />
            <button
              type="button"
              className="pill-btn primary"
              onClick={saveNewDeadline}
              disabled={!addContactId || (!addText.trim() && !addDueAt)}
              title={!addContactId ? "Pick a contact first" : !addText.trim() && !addDueAt ? "Add a description or a date" : "Save"}
            >
              <IconCheck size={11} />Save
            </button>
            <button
              type="button"
              className="pill-btn"
              onClick={resetAddForm}
            >
              Cancel
            </button>
          </div>
        )}
        {deadlines.length === 0 ? (
          <div className="ov-empty">
            No deadlines set. Click "Add deadline" above, or open any contact's Next step cell in the table.
          </div>
        ) : (
          <div className="ov-list">{deadlines.map(renderDeadlineRow)}</div>
        )}
      </section>

      <section className="ov-section">
        <header className="ov-head">
          <h3 className="ov-title">Open messages</h3>
          <span className="ov-count">{needsReply.length}</span>
          <span className="ov-hint">
            Inbound messages you haven't responded to yet — sorted oldest first.
          </span>
        </header>
        {needsReply.length === 0 ? (
          <div className="ov-empty">All caught up — no inbound messages waiting on you.</div>
        ) : (
          <div className="ov-list">{needsReply.map(renderRow)}</div>
        )}
      </section>

      <section className="ov-section">
        <header className="ov-head">
          <h3 className="ov-title">Follow up</h3>
          <span className="ov-count">{followUp.length}</span>
          <span className="ov-hint">
            Outbound messages ≥ {OVERVIEW_FOLLOWUP_DAYS} days old with no reply yet — time to nudge.
          </span>
        </header>
        {followUp.length === 0 ? (
          <div className="ov-empty">No follow-ups due.</div>
        ) : (
          <div className="ov-list">
            {followUp.map(renderRow)}
          </div>
        )}
      </section>
    </div>
  );
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
      onClick={(e) => { e.stopPropagation(); setEditing(true); }}
      style={{ width: "100%", display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}
      title="Click to edit"
    >
      <span style={{ color: "var(--accent)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
        {display}
      </span>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title="Open"
        onClick={(e) => e.stopPropagation()}
        style={{ color: "var(--text-mute)", flex: "0 0 auto", display: "inline-flex" }}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 3h3v3" />
          <path d="M13 3l-7 7" />
          <path d="M12 9v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
        </svg>
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
      onClick={(e) => { e.stopPropagation(); setEditing(true); }}
      style={{ width: "100%", display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}
      title="Click to edit"
    >
      {value ? (
        <>
          <span style={{ color: "var(--accent)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
            {value}
          </span>
          <a
            href={`mailto:${value}`}
            title={`Email ${value}`}
            onClick={(e) => e.stopPropagation()}
            style={{ color: "var(--text-mute)", flex: "0 0 auto", display: "inline-flex" }}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 4h12v8H2z" />
              <path d="M2 4l6 5 6-5" />
            </svg>
          </a>
        </>
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
  const modal = useModal();
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
                    onClick={async () => {
                      setMenuOpen(false);
                      const ok = await modal.confirm({
                        title: `Delete the "${col.label}" column?`,
                        message: `The column is removed from the table. The cell values stay attached to each contact, so re-adding a column won't restore them visibly — but no data is wiped from the database.`,
                        confirmLabel: "Delete column",
                        destructive: true,
                      });
                      if (ok) onDelete();
                    }}
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
      width:
        pickedType === "checkbox" ? "80px" :
        pickedType === "number" ? "90px" :
        pickedType === "page" ? "180px" :
        pickedType === "file" ? "200px" :
        "200px",
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
  contacts, onOpen, onPatch, columns, onColumnsChange, stages, rowHeight, onRowHeightChange, onOpenPage,
  groupByCompany,
}: {
  contacts: CrmContact[];
  onOpen: (c: CrmContact) => void;
  onPatch: (id: string, patch: Partial<CrmContact>) => void;
  columns: CrmColumnDef[];
  onColumnsChange: (next: CrmColumnDef[]) => void;
  stages: StageDef[];
  rowHeight: CrmRowHeight;
  /** Open the focused page editor for a given contact + doc id. Used by
   *  Page-type cells and by the drawer's Pages list. */
  onOpenPage: (contact: CrmContact, docId: string) => void;
  /** Persist a new row height (px). Drag-resize from the header bottom
   *  edge calls this on pointer release. */
  onRowHeightChange: (next: CrmRowHeight) => void;
  /** Companies view — when true, rows are grouped under aggregate
   *  company header rows ordered by stale-then-warmest. */
  groupByCompany: boolean;
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
    // rAF coalesce — pointermove fires up to 1000Hz on some hardware;
    // setState on every event chokes weak CPUs because each one triggers
    // a grid-template-columns recalc + full table reflow. One update per
    // animation frame is plenty for smooth drag feedback.
    let pending = false;
    let lastX = startX;
    const flush = () => {
      pending = false;
      const next = Math.max(60, Math.round(startW + (lastX - startX)));
      setLiveWidth({ id: colId, px: next });
    };
    const onMove = (ev: PointerEvent) => {
      lastX = ev.clientX;
      if (pending) return;
      pending = true;
      requestAnimationFrame(flush);
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

  // Trailing 1fr column absorbs whatever wrap-width is left over so the
  // header strip + row backgrounds extend across the full canvas instead
  // of cutting off at the last user column.
  const gridTemplate = visibleCols.map((c) => {
    if (liveWidth && liveWidth.id === c.id) return `${liveWidth.px}px`;
    return c.width ?? "200px";
  }).join(" ") + " 36px 1fr";

  // Row-height drag — same pattern as the column-width handle. Drag any
  // body row's bottom edge OR the header's bottom edge to set the
  // board-wide row height. Live preview via a CSS var on the wrap.
  const [liveRowH, setLiveRowH] = useState<number | null>(null);
  const rowResizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { rowResizeCleanupRef.current?.(); rowResizeCleanupRef.current = null; }, []);

  const startRowResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    rowResizeCleanupRef.current?.();
    const startY = e.clientY;
    const startH = rowHeight;
    // rAF coalesce — same reasoning as column resize. Every row's height
    // var updates on each setState, so on a 500-row table this is the
    // single most expensive interaction in the app on slow CPUs.
    let pending = false;
    let lastY = startY;
    const flush = () => {
      pending = false;
      setLiveRowH(clampRowHeight(startH + (lastY - startY)));
    };
    const onMove = (ev: PointerEvent) => {
      lastY = ev.clientY;
      if (pending) return;
      pending = true;
      requestAnimationFrame(flush);
    };
    const onUp = (ev: PointerEvent) => {
      cleanup();
      const next = clampRowHeight(startH + (ev.clientY - startY));
      setLiveRowH(null);
      if (next !== rowHeight) onRowHeightChange(next);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      rowResizeCleanupRef.current = null;
    };
    rowResizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const effectiveRowH = liveRowH ?? rowHeight;

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

  // ---- Companies grouping ----
  const companyGroups = useMemo(
    () => (groupByCompany ? computeCompanyGroups(contacts, stages, columns) : []),
    [groupByCompany, contacts, stages, columns],
  );
  // Collapsed company keys. Ephemeral — resets on remount, which is fine
  // for a view toggle most users leave on once they turn it on.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

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
        case "page": {
          const docs = p.documents ?? [];
          return (
            <PageCellEditor
              value={val}
              documents={docs}
              onOpenExisting={(docId) => onOpenPage(p, docId)}
              onCreateLinked={() => {
                const id = `doc_${Math.random().toString(36).slice(2, 10)}`;
                const now = new Date().toISOString();
                const nextDocs = [...docs, { id, title: "Untitled", body: "", updatedAt: now }];
                onPatch(p.id, { documents: nextDocs, customFields: { [col.id]: id } });
                onOpenPage(p, id);
              }}
            />
          );
        }
        case "file":     return <FileCellEditor value={val} contactId={p.id} onSave={setVal} />;
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
      case "lastTouch": return (
        <TouchCell
          at={p.lastTouchAt}
          direction={p.lastTouchDirection}
          onChange={(patch) => onPatch(p.id, patch)}
        />
      );
      case "nextStep":return (
        <NextStepCell
          text={p.nextStep}
          dueAt={p.nextStepDueAt}
          onChange={(patch) => onPatch(p.id, patch)}
        />
      );
      case "source":  return <span className="src-chip">{p.source ?? ""}</span>;
      case "messageNotes": return <LongTextCellEditor value={p.messageNotes} onSave={(v) => onPatch(p.id, { messageNotes: v })} />;
      case "notes":   return <LongTextCellEditor value={p.notes} onSave={(v) => onPatch(p.id, { notes: v })} />;
      default:        return null;
    }
  };

  return (
    <div className="tbl-wrap" style={{ "--rh": `${effectiveRowH}px` } as React.CSSProperties}>
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
          {/* Trailing spacer cell consumes 1fr of leftover wrap width so
              the header strip extends across the full canvas. */}
          <div className="tbl-cell hdr tbl-tail" />
          {/* Row-height drag handle — sits on the header's bottom edge,
              spans the full row width, drag down/up to set the
              board-wide row height. */}
          <span className="row-resize" onPointerDown={startRowResize} title="Drag to resize rows" />
        </div>
        {(() => {
          const renderRow = (p: CrmContact, i: number) => (
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
              <div className="tbl-cell tbl-tail" />
            </div>
          );
          if (!groupByCompany) return contacts.map(renderRow);
          let runningIdx = 0;
          return companyGroups.map((group) => {
            const collapsed = collapsedGroups.has(group.key);
            return (
              <Fragment key={group.key}>
                <div
                  className={`tbl-group-head${group.isStale ? " tbl-group-stale" : ""}`}
                  onClick={() => toggleGroup(group.key)}
                  role="button"
                  tabIndex={0}
                  aria-expanded={!collapsed}
                >
                  <span className="tgh-chev">{collapsed ? "▶" : "▼"}</span>
                  <span className="tgh-name">{group.label}</span>
                  <span className="tgh-count">
                    {group.contacts.length} {group.contacts.length === 1 ? "contact" : "contacts"}
                  </span>
                  {group.lastTouchAt && group.lastTouchDirection && (
                    <span className="tgh-touch">
                      <span className={`touch-arrow ${group.lastTouchDirection === "out" ? "touch-out-arrow" : "touch-in-arrow"}`}>
                        {group.lastTouchDirection === "out" ? "↗" : "↘"}
                      </span>
                      {formatRelativeTime(group.lastTouchAt)}
                    </span>
                  )}
                  {group.warmestStageLabel && (
                    <span
                      className="tgh-stage tbl-stage"
                      style={{
                        "--stage-color": group.warmestStageColor ?? "var(--text-mute)",
                        "--stage-tint": tintFor(group.warmestStageColor ?? "oklch(0.7 0.04 280)"),
                      } as React.CSSProperties}
                    >
                      {group.warmestStageLabel}
                    </span>
                  )}
                  {group.isStale && <span className="tgh-stale-pill">Needs follow-up</span>}
                </div>
                {!collapsed && group.contacts.map((p) => {
                  const row = renderRow(p, runningIdx);
                  runningIdx += 1;
                  return row;
                })}
              </Fragment>
            );
          });
        })()}
        {contacts.length === 0 && (
          <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-mute)", fontSize: 13 }}>
            No contacts yet. Click <strong>Import CSV</strong> to paste your spreadsheet, or <strong>Add contact</strong> to create one.
          </div>
        )}
      </div>
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
  boardName, onClose, onAdd, locationLabel,
}: {
  boardName: string;
  onClose: () => void;
  onAdd: (d: { name: string; title?: string; company?: string; email?: string; linkedin?: string; location?: string }) => Promise<void>;
  /** When the active board has a Location-style custom column, the modal
   *  renders a Location field labelled with the user's exact column name
   *  (so a board with column "City" shows "City", not "Location"). When
   *  undefined the field is hidden — no point asking for a value the
   *  board has nowhere to put. */
  locationLabel?: string;
}) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [linkedin, setLinkedin] = useState("");
  const [location, setLocation] = useState("");
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
        location: location.trim() || undefined,
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
          {locationLabel && (
            <Field label={locationLabel}>
              <input value={location} onChange={(e) => setLocation(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && canSave) submit(); }}
                placeholder="e.g. London, United Kingdom" style={{ padding: "8px 10px", background: "var(--panel)", border: "1px solid var(--hairline)", borderRadius: 8, fontSize: 12.5, color: "var(--text)" }}/>
            </Field>
          )}
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

/** Focused page editor — replaces the drawer body when a page is open.
 *  Title input on top, full-height body textarea below. Saves go through
 *  the parent drawer's onPatch via the onChange callback. */
/** Full-screen Notion-style page editor. Sits above everything with a
 *  backdrop, click outside or press Esc to close. Title input on top,
 *  body textarea fills the rest of the canvas. */
function PageOverlayEditor({
  contactName, page, onChange, onClose, onDelete,
}: {
  contactName: string;
  page: { id: string; title: string; body: string; updatedAt: string };
  onChange: (patch: { title?: string; body?: string }) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const modal = useModal();
  // Esc closes — same affordance as a modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="page-overlay-bg" onClick={onClose} />
      <div className="page-overlay" role="dialog" aria-modal="true">
        <div className="page-overlay-head">
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <button className="icon-btn" onClick={onClose} title="Close">
              <IconClose size={15} />
            </button>
            <span style={{ fontSize: 12, color: "var(--text-mute)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {contactName} · Page
            </span>
          </div>
          <button
            className="pill-btn"
            style={{ color: "var(--danger, oklch(0.55 0.2 25))" }}
            onClick={async () => {
              const ok = await modal.confirm({
                title: `Delete "${page.title || "Untitled"}"?`,
                confirmLabel: "Delete page",
                destructive: true,
              });
              if (ok) onDelete();
            }}
          >
            <IconClose size={11} />Delete
          </button>
        </div>
        <div className="page-overlay-body">
          <input
            className="page-title"
            defaultValue={page.title}
            placeholder="Untitled"
            autoFocus={!page.title}
            onBlur={(e) => { if (e.target.value !== page.title) onChange({ title: e.target.value }); }}
          />
          <textarea
            className="page-body"
            defaultValue={page.body}
            placeholder="Type anything — Shift+Enter for newline. Markdown links work."
            onBlur={(e) => { if (e.target.value !== page.body) onChange({ body: e.target.value }); }}
          />
        </div>
      </div>
    </>
  );
}

export function CRMDrawer({
  contact, idx, onClose, onPatch, onDelete, columns = [], stages = DEFAULT_STAGES, onColumnsChange, onOpenPage,
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
  /** Hand a page open request up to the parent so it opens in the
   *  fullscreen overlay rather than swapping the drawer body. */
  onOpenPage?: (contactId: string, docId: string) => void;
}) {
  const modal = useModal();
  const stageList = stages.length > 0 ? stages : DEFAULT_STAGES;
  const documents = contact.documents ?? [];

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
        case "page": {
          const docs = contact.documents ?? [];
          return (
            <PageCellEditor
              value={val}
              documents={docs}
              onOpenExisting={(docId) => onOpenPage?.(contact.id, docId)}
              onCreateLinked={() => {
                const id = `doc_${Math.random().toString(36).slice(2, 10)}`;
                const now = new Date().toISOString();
                const nextDocs = [...docs, { id, title: "Untitled", body: "", updatedAt: now }];
                onPatch(contact.id, { documents: nextDocs, customFields: { [col.id]: id } });
                onOpenPage?.(contact.id, id);
              }}
            />
          );
        }
        case "file":     return <FileCellEditor value={val} contactId={contact.id} onSave={setVal} />;
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
      case "lastTouch": return (
        <TouchCell
          at={contact.lastTouchAt}
          direction={contact.lastTouchDirection}
          onChange={(patch) => onPatch(contact.id, patch)}
        />
      );
      case "nextStep":     return (
        <NextStepCell
          text={contact.nextStep}
          dueAt={contact.nextStepDueAt}
          onChange={(patch) => onPatch(contact.id, patch)}
        />
      );
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
              </div>
            ))}
            {onColumnsChange && (
              <DrawerAddField
                onAdd={(col) => onColumnsChange([...columns, col])}
              />
            )}
          </div>

          {contact.background && (
            <div
              className="drawer-bg-block"
              // Background is LLM-generated markdown with inline links.
              // Render it minimally — linkify [label](url) and preserve
              // bullets. Source: trusted backend, no user input.
              dangerouslySetInnerHTML={{ __html: renderBackgroundMarkdown(contact.background) }}
            />
          )}

          {/* Notion-style page body — one big freeform notes area, no
              header, just a typing surface like a real page. */}
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
  viewMode: "kanban" | "table" | "overview";
  setViewMode: (v: "kanban" | "table" | "overview") => void;
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
  // People in the "in-progress middle" — sent invitations the user
  // is waiting on AND people they've already messaged via LinkedIn.
  // The toolbar exposes a binary filter:
  //   - "all"   : every contact (default)
  //   - "fresh" : hide anyone in the in-progress set — surfaces 1st-degree
  //               connections + brand-new contacts ("Connected & new").
  // Loaded from /api/people/invitations which now returns invitations +
  // connections + messaged-sent rows; connections are excluded from the
  // hide set so they stay visible.
  const [invitedNames, setInvitedNames] = useState<Set<string>>(new Set());
  const [invitedLinkedIns, setInvitedLinkedIns] = useState<Set<string>>(new Set());
  // 1st-degree connections (from Connections.csv). When this set is
  // non-empty the "fresh" filter becomes inclusive: keep a contact only
  // if they're a known connection AND not in the hide set. Empty (no
  // Connections.csv imported) → fall back to the subtractive behaviour.
  const [connectedNames, setConnectedNames] = useState<Set<string>>(new Set());
  const [connectedLinkedIns, setConnectedLinkedIns] = useState<Set<string>>(new Set());
  // Messaged-sent rows only (a subset of the hide set). Tracked separately so
  // a contact who is BOTH a 1st-degree connection AND still listed as a
  // pending invite is shown (the accepted invite just lingered in LinkedIn's
  // CSV) — while connections you've actually messaged stay hidden.
  const [messagedNames, setMessagedNames] = useState<Set<string>>(new Set());
  const [messagedLinkedIns, setMessagedLinkedIns] = useState<Set<string>>(new Set());
  const [invitedCount, setInvitedCount] = useState(0);
  const [messagedCount, setMessagedCount] = useState(0);
  const [networkFilter, setNetworkFilter] = useState<"all" | "fresh">("all");
  // Table stage filter — a set of stage ids to keep. Empty = show all.
  const [stageFilter, setStageFilter] = useState<Set<string>>(new Set());
  const [importOpen, setImportOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [openContact, setOpenContact] = useState<CrmContact | null>(null);
  // Page-type cells open in a fullscreen overlay editor — the drawer
  // doesn't swap. Tracks { contactId, docId } so we can resolve the
  // doc + contact name at render time even after a SSE refetch
  // changes object identity.
  const [editingPage, setEditingPage] = useState<{ contactId: string; docId: string } | null>(null);
  const openPage = (contactOrId: CrmContact | string, docId: string) => {
    const id = typeof contactOrId === "string" ? contactOrId : contactOrId.id;
    setEditingPage({ contactId: id, docId });
  };
  const closePage = () => setEditingPage(null);
  const [loading, setLoading] = useState(true);
  const [enriching, setEnriching] = useState(false);
  const [backgrounding, setBackgrounding] = useState(false);
  const [classifyingSkill, setClassifyingSkill] = useState(false);
  const [classifyingCountry, setClassifyingCountry] = useState(false);
  const [classifyingCity, setClassifyingCity] = useState(false);
  const [search, setSearch] = useState("");
  // Deferred for filtering — the input itself stays controlled by `search`
  // (so typing is always instant), but the table/kanban filter recomputes
  // against the deferred value. On slow CPUs this is the difference
  // between the textbox feeling stuck and the textbox feeling snappy.
  const deferredSearch = useDeferredValue(search);
  const [columns, setColumns] = useState<CrmColumnDef[]>(defaultColumns);
  const [rowHeight, setRowHeight] = useState<CrmRowHeight>(DEFAULT_ROW_HEIGHT);
  const [kanbanFields, setKanbanFields] = useState<string[]>(KANBAN_DEFAULT);
  const [stages, setStages] = useState<StageDef[]>(DEFAULT_STAGES);
  // Companies view — when on, the table groups contacts by company under
  // an aggregate header row showing count + last-touch + warmest stage.
  // Per-board so each board remembers its preferred view.
  const [groupByCompany, setGroupByCompany] = useState<boolean>(false);
  // Derived backward-compat shapes for callsites that haven't been
  // refactored to consume the full schema (KanbanCard, CRMDrawer, etc).
  const customCols = useMemo(() => customColsFromSchema(columns), [columns]);
  const visibleCols = useMemo(() => visibleColIds(columns), [columns]);

  // Toolbar filters. Split into two stages so that typing in the search
  // box doesn't re-run the (more expensive) network filter:
  //   networkFiltered → search-filtered
  // Each stage only recomputes when its own inputs change.
  const networkFiltered = useMemo(() => {
    const normN = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    const normL = (s: string) => s.toLowerCase().trim()
      .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\?.*$/, "").replace(/\/+$/, "");
    const hasHideSet = invitedNames.size > 0 || invitedLinkedIns.size > 0;
    const hasConnSet = connectedNames.size > 0 || connectedLinkedIns.size > 0;
    if (networkFilter === "fresh" && (hasHideSet || hasConnSet)) {
      return contacts.filter((c) => {
        const n = normN(c.name ?? "");
        const li = normL(c.linkedin ?? "");
        // Inclusive mode: when we know the user's connections, the contact
        // must actually be one of them — this drops non-connections that
        // the old subtractive filter let through.
        if (hasConnSet) {
          const isConnected =
            (n && connectedNames.has(n)) || (li && connectedLinkedIns.has(li));
          if (!isConnected) return false;
          // Connected contacts: an accepted invitation often lingers in
          // LinkedIn's "sent invitations" CSV, so DON'T hide a connection just
          // because they're still listed as invited — the invite was clearly
          // accepted (that's how they became a connection). But DO hide
          // connections you've already messaged — they're not "new".
          if (n && messagedNames.has(n)) return false;
          if (li && messagedLinkedIns.has(li)) return false;
          return true;
        }
        // Subtractive mode (no Connections.csv imported, so we can't tell who's
        // a connection): hide anyone already invited or messaged.
        if (n && invitedNames.has(n)) return false;
        if (li && invitedLinkedIns.has(li)) return false;
        return true;
      });
    }
    return contacts;
  }, [contacts, networkFilter, invitedNames, invitedLinkedIns, connectedNames, connectedLinkedIns, messagedNames, messagedLinkedIns]);

  // Stage filter — keep only contacts in the selected stages. Empty set
  // means no filter. Sits between the network filter and search so each
  // stage of the pipeline recomputes only when its own inputs change.
  const stageFiltered = useMemo(() => {
    if (stageFilter.size === 0) return networkFiltered;
    return networkFiltered.filter((c) => stageFilter.has(c.stage));
  }, [networkFiltered, stageFilter]);

  // Search-stage filter — consumes the deferred query, so the input itself
  // stays snappy on slow CPUs even when the table is large. The deps are
  // narrow: just the stage-filtered list + the search string.
  const filteredContacts = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    if (!q) return stageFiltered;
    return stageFiltered.filter((c) => {
      const haystack = [
        c.name, c.title, c.company, c.email, c.linkedin, c.background,
        ...Object.values((c.customFields ?? {}) as Record<string, string>),
      ]
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .join(" \n ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [stageFiltered, deferredSearch]);

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

  // Load the user's in-progress contacts (sent invitations + people
  // they've messaged) so the "Connected & new" filter can hide them.
  // 1st-degree connections come back tagged but are excluded — we want
  // them visible. One fetch per session; import dialogs fire events
  // that re-trigger this.
  const reloadInvitations = () => {
    api.get<{
      invitations: Array<{ name: string; linkedin: string; kind: string | null }>;
      invitedCount?: number;
      messagedCount?: number;
    }>("/api/people/invitations")
      .then((r) => {
        const hideRows = r.invitations.filter((i) => i.kind === "invitation" || i.kind === "messaged");
        setInvitedNames(new Set(hideRows.map((i) => i.name).filter(Boolean)));
        setInvitedLinkedIns(new Set(hideRows.map((i) => i.linkedin).filter(Boolean)));
        const connRows = r.invitations.filter((i) => i.kind === "connection");
        setConnectedNames(new Set(connRows.map((i) => i.name).filter(Boolean)));
        setConnectedLinkedIns(new Set(connRows.map((i) => i.linkedin).filter(Boolean)));
        // Messaged-only subset: these stay hidden even for connections (you've
        // already engaged them), unlike a stale pending-invite which a
        // connection should override.
        const messagedRows = r.invitations.filter((i) => i.kind === "messaged");
        setMessagedNames(new Set(messagedRows.map((i) => i.name).filter(Boolean)));
        setMessagedLinkedIns(new Set(messagedRows.map((i) => i.linkedin).filter(Boolean)));
        setInvitedCount(r.invitedCount ?? 0);
        setMessagedCount(r.messagedCount ?? 0);
      })
      .catch(() => { /* non-fatal — filter just stays empty */ });
  };
  useEffect(() => {
    reloadInvitations();
    const onImport = () => reloadInvitations();
    // Any of the three CSV imports updates the matching set.
    window.addEventListener("invitations-imported", onImport);
    window.addEventListener("connections-imported", onImport);
    window.addEventListener("messages-imported", onImport);
    return () => {
      window.removeEventListener("invitations-imported", onImport);
      window.removeEventListener("connections-imported", onImport);
      window.removeEventListener("messages-imported", onImport);
    };
  }, []);

  // Whenever the active board changes, prime kanban + stages from local
  // caches as a first paint. Columns and row height come from the server
  // (see the effect that follows `active?.columns` below); we only seed
  // sensible defaults here so the table doesn't flash empty on board
  // switch.
  useEffect(() => {
    if (!activeId) return;
    setRowHeight(loadRowHeightCached(activeId));
    setKanbanFields(loadKanbanFields(activeId));
    setStages(loadStages(activeId));
    setGroupByCompany(loadGroupByCompany(activeId));
    // Stage ids differ per board — clear the filter so a carried-over
    // selection doesn't hide every row on the board we just opened.
    setStageFilter(new Set());
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
    // Fingerprint of the last accepted payload. Lets us skip setContacts
    // (and the cascade of re-renders that follows) when SSE / focus /
    // poll fires but the server actually has nothing new — common on
    // shared boards where someone else's activity triggers an event but
    // didn't change a row this client cares about.
    let lastFingerprint: string | null = null;
    const fingerprintOf = (list: CrmContact[]) => {
      // Sort by id so order changes don't trigger a refresh. updatedAt
      // on every row is enough — the server bumps it on every write.
      const ids = list.map((c) => `${c.id}:${c.updatedAt}`).sort();
      return `${list.length}|${ids.join(",")}`;
    };
    const loadContacts = () => {
      api.get<{ contacts: CrmContact[] }>(`/api/crm/boards/${activeId}/contacts`)
        .then((r) => {
          if (stopped) return;
          const fp = fingerprintOf(r.contacts);
          if (fp === lastFingerprint) return;
          lastFingerprint = fp;
          setContacts(r.contacts);
        })
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
    if (active.rowHeight != null) {
      const next = normaliseRowHeight(active.rowHeight);
      setRowHeight(next);
      cacheRowHeight(active.id, next);
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

  const addContact = async (draft: { name: string; title?: string; company?: string; email?: string; linkedin?: string; location?: string }) => {
    if (!activeId) return;
    try {
      // Route a Location value into the board's Location-style custom column
      // via customFields, since location isn't a legacy DB field. The server
      // merges customFields with anything its own findCustomCol routing
      // produces from title/company/email/linkedin.
      const customFields: Record<string, string> = {};
      if (draft.location && locationCol) {
        customFields[locationCol.id] = draft.location;
      }
      const c = await api.post<CrmContact>(`/api/crm/boards/${activeId}/contacts`, {
        name: draft.name,
        title: draft.title || null,
        company: draft.company || null,
        email: draft.email || null,
        linkedin: draft.linkedin || null,
        ...(Object.keys(customFields).length > 0 ? { customFields } : {}),
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
      const r = await api.post<{ enriched: number; skipped: number; alreadyHad?: number; total: number; remaining?: number }>(
        `/api/crm/boards/${activeId}/enrich`,
      );
      const fresh = await api.get<{ contacts: CrmContact[] }>(`/api/crm/boards/${activeId}/contacts`);
      setContacts(fresh.contacts);
      const had = r.alreadyHad ?? 0;
      const remaining = r.remaining ?? 0;
      onFlash(
        `Got email for ${r.enriched}` +
        (r.skipped ? ` · ${r.skipped} no match` : "") +
        (had ? ` · ${had} already had one` : "") +
        (remaining ? ` · ${remaining} left — run Get email again to continue` : ""),
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

  /** "Classify skill" — for every contact whose Skill cell is empty, search
   *  LinkedIn via Tavily and ask the LLM to pick the closest dropdown value
   *  (typically Technical / Non technical) based on past roles + posts. The
   *  server reads the actual options off the Skill column so the user can
   *  rename them and the classifier follows. */
  const skillCol = useMemo(
    () => columns.find((c) => !c.builtin && c.type === "dropdown" && (c.label ?? "").trim().toLowerCase() === "skill"),
    [columns],
  );
  // Location custom column. Mirrors the server's findCustomCol mapping in
  // crm.ts (label hints: location/city/based/based-in) so the Add Contact
  // modal asks for a Location only when the board has somewhere to put
  // the value, AND so the field's label tracks whatever the user named
  // their column ("Based in", "City", etc.).
  const locationCol = useMemo(() => {
    const hints = new Set(["location", "city", "based", "based in"]);
    return columns.find(
      (c) => !c.builtin && c.type === "text" && hints.has((c.label ?? "").trim().toLowerCase()),
    );
  }, [columns]);
  /** Country column — text or dropdown labelled "Country". The classify
   *  button only appears when this column exists. */
  const countryCol = useMemo(
    () => columns.find(
      (c) => !c.builtin && (c.type === "text" || c.type === "dropdown") && (c.label ?? "").trim().toLowerCase() === "country",
    ),
    [columns],
  );

  const cityCol = useMemo(
    () => columns.find(
      (c) => !c.builtin && (c.type === "text" || c.type === "dropdown") && (c.label ?? "").trim().toLowerCase() === "city",
    ),
    [columns],
  );

  const classifyCountry = async () => {
    if (!activeId || classifyingCountry) return;
    if (contacts.length === 0) { onFlash("No contacts on this board yet."); return; }

    // No Country column on this board — offer to create one inline rather
    // than dead-ending the user. Same shape as classify-skill's missing-
    // column behavior, but auto-creates the column on confirm.
    let col = countryCol;
    if (!col) {
      const ok = window.confirm(
        "This board has no \"Country\" column.\n\n" +
        "Add a Text column called \"Country\" now and run the classifier?",
      );
      if (!ok) return;
      const newCol: CrmColumnDef = {
        id: makeCustomColId("Country"),
        builtin: false,
        label: "Country",
        type: "text",
        width: "180px",
      };
      const next = [...columns, newCol];
      await saveColumns(next);
      col = newCol;
    }

    const needCountry = contacts.filter((c) => {
      const cf = (c.customFields ?? {}) as Record<string, string>;
      return !((cf[col!.id] ?? "").trim());
    }).length;
    if (needCountry === 0) { onFlash("Every contact already has a Country value — nothing to classify."); return; }
    setClassifyingCountry(true);
    try {
      const r = await api.post<{ classified: number; skipped: number; alreadyHad?: number; total: number }>(
        `/api/crm/boards/${activeId}/classify-country`,
      );
      const fresh = await api.get<{ contacts: CrmContact[] }>(`/api/crm/boards/${activeId}/contacts`);
      setContacts(fresh.contacts);
      const had = r.alreadyHad ?? 0;
      onFlash(
        `Classified ${r.classified}` +
        (r.skipped ? ` · ${r.skipped} too thin to call` : "") +
        (had ? ` · ${had} already had one` : ""),
      );
    } catch (e) {
      onFlash(`Classify country failed: ${(e as Error).message}`);
    } finally {
      setClassifyingCountry(false);
    }
  };

  const classifyCity = async () => {
    if (!activeId || classifyingCity) return;
    if (contacts.length === 0) { onFlash("No contacts on this board yet."); return; }

    // No City column yet — offer to create one inline (same UX as country).
    let col = cityCol;
    if (!col) {
      const ok = window.confirm(
        "This board has no \"City\" column.\n\n" +
        "Add a Text column called \"City\" now and run the classifier?",
      );
      if (!ok) return;
      const newCol: CrmColumnDef = {
        id: makeCustomColId("City"),
        builtin: false,
        label: "City",
        type: "text",
        width: "160px",
      };
      const next = [...columns, newCol];
      await saveColumns(next);
      col = newCol;
    }

    const needCity = contacts.filter((c) => {
      const cf = (c.customFields ?? {}) as Record<string, string>;
      return !((cf[col!.id] ?? "").trim());
    }).length;
    if (needCity === 0) { onFlash("Every contact already has a City value — nothing to classify."); return; }
    setClassifyingCity(true);
    try {
      const r = await api.post<{ classified: number; skipped: number; alreadyHad?: number; total: number }>(
        `/api/crm/boards/${activeId}/classify-city`,
      );
      const fresh = await api.get<{ contacts: CrmContact[] }>(`/api/crm/boards/${activeId}/contacts`);
      setContacts(fresh.contacts);
      const had = r.alreadyHad ?? 0;
      onFlash(
        `Found city for ${r.classified}` +
        (r.skipped ? ` · ${r.skipped} too thin to call` : "") +
        (had ? ` · ${had} already had one` : ""),
      );
    } catch (e) {
      onFlash(`Find city failed: ${(e as Error).message}`);
    } finally {
      setClassifyingCity(false);
    }
  };

  const classifySkill = async () => {
    if (!activeId || classifyingSkill) return;
    if (contacts.length === 0) { onFlash("No contacts on this board yet."); return; }
    if (!skillCol) {
      onFlash("Add a dropdown column called \"Skill\" first (e.g. Technical / Non technical).");
      return;
    }
    const needSkill = contacts.filter((c) => {
      const cf = (c.customFields ?? {}) as Record<string, string>;
      return !((cf[skillCol.id] ?? "").trim());
    }).length;
    if (needSkill === 0) { onFlash("Every contact already has a Skill value — nothing to classify."); return; }
    setClassifyingSkill(true);
    try {
      const r = await api.post<{ classified: number; skipped: number; alreadyHad?: number; total: number }>(
        `/api/crm/boards/${activeId}/classify-skill`,
      );
      const fresh = await api.get<{ contacts: CrmContact[] }>(`/api/crm/boards/${activeId}/contacts`);
      setContacts(fresh.contacts);
      const had = r.alreadyHad ?? 0;
      onFlash(
        `Classified ${r.classified}` +
        (r.skipped ? ` · ${r.skipped} too thin to call` : "") +
        (had ? ` · ${had} already had one` : ""),
      );
    } catch (e) {
      onFlash(`Classify skill failed: ${(e as Error).message}`);
    } finally {
      setClassifyingSkill(false);
    }
  };

  if (loading) return <div style={{ padding: 24, color: "var(--text-dim)" }}>Loading CRM…</div>;
  if (!active) return <div style={{ padding: 24, color: "var(--text-dim)" }}>No boards yet.</div>;

  return (
    <div className="crm-wrap">
      {active && (
        <div className="crm-header">
          <h1 className="crm-title">{active.name}</h1>
        </div>
      )}
      <div className="crm-toolbar">
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div className="view-toggle">
            <button className={viewMode === "overview" ? "active" : ""} onClick={() => setViewMode("overview")} title="Things needing your attention">
              <IconSparkle size={12} />Overview
            </button>
            <button className={viewMode === "kanban" ? "active" : ""} onClick={() => setViewMode("kanban")}>
              <IconList size={12} style={{ transform: "rotate(90deg)" }} />Board
            </button>
            <button className={viewMode === "table" ? "active" : ""} onClick={() => setViewMode("table")}>
              <IconSheet size={12} />Table
            </button>
          </div>
          <label className="crm-search">
            <IconSearch size={12} />
            <input
              type="search"
              placeholder="Search contacts…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search contacts"
            />
            {search && (
              <button
                type="button"
                className="crm-search-clear"
                onClick={() => setSearch("")}
                aria-label="Clear search"
              >
                <IconClose size={11} />
              </button>
            )}
          </label>
          {search && (
            <span className="crm-search-count" aria-live="polite">
              {filteredContacts.length} of {contacts.length}
            </span>
          )}
          {/* "Connected & new" — hides in-progress contacts (invitations
              sent + people messaged), leaving 1st-degree connections and
              brand-new contacts. Click an active pill to clear. Disabled
              until the user has imported at least one of the relevant CSVs. */}
          <button
            type="button"
            className={`pill-btn${networkFilter === "fresh" ? " primary" : ""}`}
            onClick={() => setNetworkFilter((v) => (v === "fresh" ? "all" : "fresh"))}
            disabled={
              invitedNames.size === 0 && invitedLinkedIns.size === 0 &&
              connectedNames.size === 0 && connectedLinkedIns.size === 0
            }
            title={
              invitedNames.size === 0 && invitedLinkedIns.size === 0 &&
              connectedNames.size === 0 && connectedLinkedIns.size === 0
                ? "Import a Connections.csv first (Actions → Import LinkedIn data)"
                : connectedNames.size > 0 || connectedLinkedIns.size > 0
                  ? `Show only 1st-degree connections you haven't messaged yet (hides ${invitedCount} pending invites + ${messagedCount} messaged)`
                  : networkFilter === "fresh"
                    ? `Hiding ${invitedCount} pending invites + ${messagedCount} people you've messaged`
                    : `Hide ${invitedCount} pending invites + ${messagedCount} people you've messaged`
            }
          >
            <IconUsers size={12} />
            Connected &amp; new
            {networkFilter === "fresh" && (
              <span style={{ fontFamily: "'Geist Mono', monospace", fontSize: 10.5, color: "var(--text-mute)" }}>
                ({filteredContacts.length})
              </span>
            )}
          </button>
          {/* Stage filter — table view only; the kanban already reads
              stage-by-stage as columns, so a stage filter there is redundant. */}
          {viewMode === "table" && (
            <StageFilterMenu stages={stages} value={stageFilter} onChange={setStageFilter} />
          )}
        </div>
        <div className="crm-tools">
          {enriching && (
            <span className="crm-progress-pill" role="status" aria-live="polite">
              <span className="crm-spinner" aria-hidden="true" />
              Getting emails…
            </span>
          )}
          {backgrounding && (
            <span className="crm-progress-pill" role="status" aria-live="polite">
              <span className="crm-spinner" aria-hidden="true" />
              Researching backgrounds…
            </span>
          )}
          {classifyingSkill && (
            <span className="crm-progress-pill" role="status" aria-live="polite">
              <span className="crm-spinner" aria-hidden="true" />
              Classifying skill…
            </span>
          )}
          {classifyingCountry && (
            <span className="crm-progress-pill" role="status" aria-live="polite">
              <span className="crm-spinner" aria-hidden="true" />
              Classifying country…
            </span>
          )}
          {classifyingCity && (
            <span className="crm-progress-pill" role="status" aria-live="polite">
              <span className="crm-spinner" aria-hidden="true" />
              Finding city…
            </span>
          )}
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
                    columns={columns}
                  />
                )}
                {viewMode === "table" && (
                  <button
                    className={`pill-btn${groupByCompany ? " primary" : ""}`}
                    onClick={() => {
                      const next = !groupByCompany;
                      setGroupByCompany(next);
                      saveGroupByCompany(activeId, next);
                    }}
                    title="Group rows by company with an aggregate header row above each group"
                  >
                    <IconUsers size={12} />{groupByCompany ? "Grouped by company" : "Group by company"}
                  </button>
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
                {skillCol && (
                  <button
                    className="pill-btn"
                    disabled={classifyingSkill}
                    onClick={() => { close(); classifySkill(); }}
                    title={`Auto-fill the "${skillCol.label ?? "Skill"}" column by reading each contact's LinkedIn (technical roles, posts, articles).`}
                  >
                    <IconSparkle size={12} />{classifyingSkill ? "Classifying…" : "Classify skill"}
                  </button>
                )}
                <button
                  className="pill-btn"
                  disabled={classifyingCountry}
                  onClick={() => { close(); classifyCountry(); }}
                  title={
                    countryCol
                      ? `Auto-fill the "${countryCol.label ?? "Country"}" column by reading each contact's LinkedIn location.`
                      : "Adds a Country column to this board and fills it from each contact's LinkedIn location."
                  }
                >
                  <IconSparkle size={12} />{classifyingCountry ? "Classifying…" : "Classify country"}
                </button>
                <button
                  className="pill-btn"
                  disabled={classifyingCity}
                  onClick={() => { close(); classifyCity(); }}
                  title={
                    cityCol
                      ? `Auto-fill the "${cityCol.label ?? "City"}" column by finding each contact's city on the web.`
                      : "Adds a City column to this board and fills it with each contact's city, found on the web."
                  }
                >
                  <IconSparkle size={12} />{classifyingCity ? "Finding…" : "Find city"}
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

      {viewMode === "kanban" && (
        <KanbanBoard
          contacts={filteredContacts}
          onOpen={setOpenContact}
          onMoveStage={(id, stage) => patchContact(id, { stage })}
          onDelete={deleteContact}
          fields={kanbanFields}
          columns={columns}
          stages={stages}
          onStagesChange={persistStages}
          onReassign={reassignStage}
        />
      )}
      {viewMode === "table" && (
        <TableView
          contacts={filteredContacts}
          onOpen={setOpenContact}
          onPatch={patchContact}
          columns={columns}
          onColumnsChange={saveColumns}
          stages={stages}
          rowHeight={rowHeight}
          onRowHeightChange={saveRowHeight}
          onOpenPage={openPage}
          groupByCompany={groupByCompany}
        />
      )}
      {viewMode === "overview" && (
        <OverviewView
          contacts={filteredContacts}
          onOpen={setOpenContact}
          onPatch={patchContact}
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
          locationLabel={locationCol?.label}
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
          onOpenPage={(contactId, docId) => openPage(contactId, docId)}
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

      {editingPage && (() => {
        const c = contacts.find((x) => x.id === editingPage.contactId);
        const doc = c?.documents?.find((d) => d.id === editingPage.docId);
        if (!c || !doc) return null;
        return (
          <PageOverlayEditor
            contactName={c.name}
            page={doc}
            onChange={(patch) => {
              const nextDocs = (c.documents ?? []).map((d) => (
                d.id === doc.id ? { ...d, ...patch, updatedAt: new Date().toISOString() } : d
              ));
              patchContact(c.id, { documents: nextDocs });
            }}
            onClose={closePage}
            onDelete={() => {
              const nextDocs = (c.documents ?? []).filter((d) => d.id !== doc.id);
              patchContact(c.id, { documents: nextDocs });
              closePage();
            }}
          />
        );
      })()}
    </div>
  );
}

