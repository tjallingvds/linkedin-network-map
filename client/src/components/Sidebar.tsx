/**
 * Sidebar — collapsible, with a working search and a live API-usage card in
 * place of the old "Upgrade to Pro" pitch.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  IconNewChat, IconSidebar, IconSearch, IconUsers, IconSparkle, IconClose,
} from "../design/icons";

export interface NavEntry {
  id: string;
  label: string;
  count: number;
}

export interface UsageBucket {
  label: string;
  used: number;
  max: number;
  unit: string;
}

interface Props {
  activeNav: string;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onNewBoard?: () => void;
  savedSearches: NavEntry[];
  lists: NavEntry[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  usage: UsageBucket[];
  onOpenSettings: () => void;
  /** Optional — when supplied, each saved-search row gets rename + delete hover actions. */
  onRenameSearch?: (id: string, title: string) => void | Promise<void>;
  onDeleteSearch?: (id: string) => void | Promise<void>;
  onDeleteBoard?: (id: string) => void | Promise<void>;
  onRenameBoard?: (id: string, title: string) => void | Promise<void>;
}

export function Sidebar({
  activeNav, onSelect, onNewChat, onNewBoard, savedSearches, lists,
  collapsed, onToggleCollapse, usage, onOpenSettings,
  onRenameSearch, onDeleteSearch, onRenameBoard, onDeleteBoard,
}: Props) {
  const [q, setQ] = useState("");

  const filteredSearches = useMemo(
    () => filterByQuery(savedSearches, q),
    [savedSearches, q],
  );
  const filteredLists = useMemo(() => filterByQuery(lists, q), [lists, q]);

  return (
    <aside className={`sidebar${collapsed ? " collapsed" : ""}`}>
      {/* Sidebar header — single 54px row in both states so the divider
          lines up with the topbar's bottom border across the whole app. */}
      <div className="sidebar-header">
        <div className="brand-l">
          <div className="brand-mark" title="Nontrivial" />
          {!collapsed && <span className="brand-name">Nontrivial</span>}
        </div>
        {!collapsed && (
          <button className="icon-btn" title="Collapse sidebar" onClick={onToggleCollapse}>
            <IconSidebar size={14} />
          </button>
        )}
      </div>

      <div className="sidebar-body">
        {collapsed ? (
          <>
            <button className="icon-btn" title="Expand sidebar" onClick={onToggleCollapse}>
              <IconSidebar size={14} />
            </button>
            <button
              className="icon-btn"
              style={{ background: "var(--text)", color: "var(--shell)" }}
              title="New search"
              onClick={onNewChat}
            >
              <IconNewChat size={14} />
            </button>
          </>
        ) : (
          <>
            <div className="search-input">
              <IconSearch size={13} />
              <input
                placeholder="Search prospects, lists…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>

            <NavSection
              label="Past searches"
              items={filteredSearches}
              icon={<IconSearch size={13} />}
              activeNav={activeNav}
              onSelect={onSelect}
              emptyMsg={q ? "No matches" : savedSearches.length === 0 ? "Your searches appear here" : undefined}
              onRename={onRenameSearch}
              onDelete={onDeleteSearch}
              onAdd={onNewChat}
              addTitle="New search"
            />

            <NavSection
              label="CRM boards"
              items={filteredLists}
              icon={<IconUsers size={13} />}
              activeNav={activeNav}
              onSelect={onSelect}
              emptyMsg={q ? "No matches" : lists.length === 0 ? "Create your first board" : undefined}
              onRename={onRenameBoard}
              onDelete={onDeleteBoard}
              onAdd={onNewBoard}
              addTitle="New board"
            />

            <div className="sidebar-spacer" />

            <UsageCard usage={usage} onOpenSettings={onOpenSettings} />
          </>
        )}
      </div>
    </aside>
  );
}

// ---------- helpers ----------

function filterByQuery(items: NavEntry[], q: string): NavEntry[] {
  if (!q.trim()) return items;
  const needle = q.toLowerCase();
  return items.filter((i) => i.label.toLowerCase().includes(needle));
}

function NavSection({
  label, items, icon, activeNav, onSelect, emptyMsg, onRename, onDelete, onAdd, addTitle,
}: {
  label: string;
  items: NavEntry[];
  icon: React.ReactNode;
  activeNav: string;
  onSelect: (id: string) => void;
  emptyMsg?: string;
  onRename?: (id: string, title: string) => void | Promise<void>;
  onDelete?: (id: string) => void | Promise<void>;
  onAdd?: () => void;
  addTitle?: string;
}) {
  return (
    <div className="nav-section">
      <div className="nav-label">
        <span>{label}</span>
        {onAdd && (
          <button className="nav-add" title={addTitle ?? `New ${label.toLowerCase()}`} onClick={onAdd}>
            <PlusIcon />
          </button>
        )}
      </div>
      {items.length === 0 && emptyMsg ? (
        <div style={{ padding: "6px 10px", fontSize: 11.5, color: "var(--text-mute)" }}>{emptyMsg}</div>
      ) : (
        items.map((s) => (
          <NavRow
            key={s.id}
            entry={s}
            icon={icon}
            active={activeNav === s.id}
            onSelect={onSelect}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))
      )}
    </div>
  );
}

function NavRow({
  entry, icon, active, onSelect, onRename, onDelete,
}: {
  entry: NavEntry;
  icon: React.ReactNode;
  active: boolean;
  onSelect: (id: string) => void;
  onRename?: (id: string, title: string) => void | Promise<void>;
  onDelete?: (id: string) => void | Promise<void>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [value, setValue] = useState(entry.label);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setValue(entry.label); }, [entry.label]);
  useEffect(() => { if (renaming) { inputRef.current?.focus(); inputRef.current?.select(); } }, [renaming]);

  const commit = async () => {
    const next = value.trim();
    setRenaming(false);
    if (!next || next === entry.label) { setValue(entry.label); return; }
    try { await onRename?.(entry.id, next); }
    catch { setValue(entry.label); }
  };

  if (renaming) {
    return (
      <div className={`nav-item ${active ? "active" : ""}`}>
        {icon}
        <input
          ref={inputRef}
          className="nav-rename-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") { setValue(entry.label); setRenaming(false); }
          }}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    );
  }

  return (
    <div
      className={`nav-item nav-row ${active ? "active" : ""}`}
      onClick={() => onSelect(entry.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onSelect(entry.id); }}
    >
      {icon}
      <span className="nav-row-label">{entry.label}</span>
      {(onRename || onDelete) && (
        <div className="nav-row-actions" onClick={(e) => e.stopPropagation()}>
          {onRename && (
            <button
              className="nav-row-action"
              title="Rename"
              onClick={(e) => { e.stopPropagation(); setRenaming(true); }}
            >
              <PencilIcon />
            </button>
          )}
          {onDelete && (
            <button
              className="nav-row-action danger"
              title="Delete"
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(`Delete "${entry.label}"?`)) onDelete(entry.id);
              }}
            >
              <IconClose size={11} />
            </button>
          )}
        </div>
      )}
      {entry.count > 0 && <span className="count">{entry.count}</span>}
    </div>
  );
}

function PencilIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.2 2.8a1.8 1.8 0 1 1 2.6 2.6L6 14.2l-3.5.9.9-3.5 8.8-8.8z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function UsageCard({ usage, onOpenSettings }: { usage: UsageBucket[]; onOpenSettings: () => void }) {
  const view = usage.length > 0 ? usage : [
    { label: "Search", used: 0, max: 10_000, unit: "" },
    { label: "Enrich", used: 0, max: 5_000, unit: "" },
    { label: "LLM", used: 0, max: 5_000_000, unit: "" },
  ];

  return (
    <div className="upgrade">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <h4 style={{ margin: 0 }}>Usage</h4>
        <IconSparkle size={12} style={{ color: "var(--text-mute)" }} />
      </div>
      <p style={{ marginBottom: 10 }}>Month-to-date activity.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {view.map((u) => {
          const pct = u.max > 0 ? Math.min(100, Math.round((u.used / u.max) * 100)) : 0;
          const over = pct > 90;
          return (
            <div key={u.label}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--text-dim)", marginBottom: 3 }}>
                <span>{u.label}</span>
                <span style={{ fontFamily: "Geist Mono, monospace", color: over ? "var(--danger)" : "var(--text-mute)" }}>
                  {u.used.toLocaleString()} / {u.max.toLocaleString()}{u.unit}
                </span>
              </div>
              <div style={{ width: "100%", height: 4, borderRadius: 2, background: "var(--hairline)", overflow: "hidden" }}>
                <div style={{
                  width: `${pct}%`, height: "100%",
                  background: over ? "var(--danger)" : "var(--accent)",
                  transition: "width 200ms",
                }} />
              </div>
            </div>
          );
        })}
      </div>
      <button
        style={{
          width: "100%", marginTop: 12, padding: "6px 12px",
          borderRadius: 8, background: "transparent",
          color: "var(--text-dim)", fontSize: 11.5,
          border: "1px solid var(--hairline)",
        }}
        onClick={onOpenSettings}
      >
        Manage API keys
      </button>
    </div>
  );
}
