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
  savedSearches: NavEntry[];
  lists: NavEntry[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  usage: UsageBucket[];
  balance: number;
  onOpenSettings: () => void;
  onGetMoreUsage: () => void;
  /** Optional — when supplied, each saved-search row gets rename + delete hover actions. */
  onRenameSearch?: (id: string, title: string) => void | Promise<void>;
  onDeleteSearch?: (id: string) => void | Promise<void>;
}

export function Sidebar({
  activeNav, onSelect, onNewChat, savedSearches, lists,
  collapsed, onToggleCollapse, usage, balance, onOpenSettings, onGetMoreUsage,
  onRenameSearch, onDeleteSearch,
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
            <button className="new-chat" onClick={onNewChat}>
              <IconNewChat size={14} />
              <span>New search</span>
              <span className="kbd">⌘N</span>
            </button>

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
            />

            <NavSection
              label="CRM boards"
              items={filteredLists}
              icon={<IconUsers size={13} />}
              activeNav={activeNav}
              onSelect={onSelect}
              emptyMsg={q ? "No matches" : lists.length === 0 ? "Create a board in the CRM tab" : undefined}
            />

            <div className="sidebar-spacer" />

            <UsageCard
              usage={usage}
              balance={balance}
              onOpenSettings={onOpenSettings}
              onGetMoreUsage={onGetMoreUsage}
            />
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
  label, items, icon, activeNav, onSelect, emptyMsg, onRename, onDelete,
}: {
  label: string;
  items: NavEntry[];
  icon: React.ReactNode;
  activeNav: string;
  onSelect: (id: string) => void;
  emptyMsg?: string;
  onRename?: (id: string, title: string) => void | Promise<void>;
  onDelete?: (id: string) => void | Promise<void>;
}) {
  return (
    <div className="nav-section">
      <div className="nav-label">
        <span>{label}</span>
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

function UsageCard({
  usage, balance, onOpenSettings, onGetMoreUsage,
}: {
  usage: UsageBucket[];
  balance: number;
  onOpenSettings: () => void;
  onGetMoreUsage: () => void;
}) {
  // Fallback buckets when the real fetch hasn't completed yet.
  const view = usage.length > 0 ? usage : [
    { label: "Search", used: 0, max: 10_000, unit: "" },
    { label: "Enrich", used: 0, max: 5_000, unit: "" },
    { label: "LLM", used: 0, max: 5_000_000, unit: "" },
  ];

  const low = balance < 20;

  return (
    <div className="upgrade">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <h4 style={{ margin: 0 }}>Credits</h4>
        <span className="balance-chip" style={low ? { background: "oklch(0.58 0.17 25 / 0.12)", color: "var(--danger)", borderColor: "oklch(0.58 0.17 25 / 0.3)" } : undefined}>
          <IconSparkle size={10} />
          {balance.toLocaleString()}
        </span>
      </div>
      <p style={{ marginBottom: 10 }}>1 credit = 1 search or enrichment call.</p>
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
      <button className="upgrade-btn" style={{ marginTop: 12 }} onClick={onGetMoreUsage}>
        Get more credits
      </button>
      <button
        style={{
          width: "100%", marginTop: 6, padding: "6px 12px",
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
