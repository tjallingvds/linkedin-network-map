/**
 * Sidebar — midday-style icon rail. Collapsed it is a 70px column of icons;
 * on hover it expands to 240px and reveals labels + the dynamic Boards /
 * Recent lists (midday's Item→children pattern). Ported from
 * midday-ai/midday's Sidebar + MainMenu onto this app's data + actions.
 */
import { useEffect, useRef, useState } from "react";
import { Icons } from "../ui/components/icons";
import { cn } from "../ui/utils";
import { useModal } from "./Modal";

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
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  usage?: UsageBucket[];
  onOpenSettings: () => void;
  userInitials?: string;
  userEmail?: string;
  onRenameSearch?: (id: string, title: string) => void | Promise<void>;
  onDeleteSearch?: (id: string) => void | Promise<void>;
  onDeleteBoard?: (id: string) => void | Promise<void>;
  onRenameBoard?: (id: string, title: string) => void | Promise<void>;
  approvalCount?: number;
  onOpenApprovals?: () => void;
  approvalsActive?: boolean;
}

export function Sidebar({
  activeNav, onSelect, onNewChat, onNewBoard, savedSearches, lists,
  onOpenSettings, userInitials, userEmail,
  onRenameSearch, onDeleteSearch, onRenameBoard, onDeleteBoard,
  approvalCount = 0, onOpenApprovals, approvalsActive,
}: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <aside
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      className={cn(
        "md-rail fixed top-0 left-0 h-screen z-50 flex flex-col justify-between",
        "bg-background border-r border-border overflow-hidden",
        "transition-[width] duration-200 ease-out",
        expanded ? "w-[240px]" : "w-[70px]",
      )}
    >
      {/* Brand box — fixed 70px header, mark pinned at the rail edge. */}
      <div className="relative h-[70px] shrink-0 flex items-center border-b border-border">
        <div className="absolute left-[19px] flex items-center gap-3">
          <BrandMark />
          <span
            className={cn(
              "whitespace-nowrap text-sm font-medium text-foreground transition-opacity duration-200",
              expanded ? "opacity-100" : "opacity-0",
            )}
          >
            Observable Intuition
          </span>
        </div>
      </div>

      {/* Menu */}
      <div className="flex-1 flex flex-col w-full pt-4 gap-1 overflow-y-auto scrollbar-hide">
        {onOpenApprovals && (
          <RailItem
            icon={<Icons.Check size={20} />}
            label="Need approval"
            expanded={expanded}
            active={!!approvalsActive}
            badge={approvalCount > 0 ? approvalCount : undefined}
            onClick={onOpenApprovals}
          />
        )}

        <RailItem
          icon={<Icons.Search size={20} />}
          label="New search"
          expanded={expanded}
          onClick={onNewChat}
        />

        <div className="my-2 mx-[15px] border-b border-border" />

        <RailGroup
          icon={<Icons.Customers size={20} />}
          label="Boards"
          expanded={expanded}
          onAdd={onNewBoard}
          addTitle="New board"
          emptyMsg={lists.length === 0 ? "Create your first board" : undefined}
        >
          {lists.map((b) => (
            <ChildRow
              key={b.id}
              entry={b}
              active={activeNav === b.id}
              expanded={expanded}
              onSelect={onSelect}
              onRename={onRenameBoard}
              onDelete={onDeleteBoard}
            />
          ))}
        </RailGroup>

        <RailGroup
          icon={<Icons.History size={20} />}
          label="Recent"
          expanded={expanded}
          onAdd={onNewChat}
          addTitle="New search"
          emptyMsg={savedSearches.length === 0 ? "Your searches appear here" : undefined}
        >
          {savedSearches.map((s) => (
            <ChildRow
              key={s.id}
              entry={s}
              active={activeNav === s.id}
              expanded={expanded}
              onSelect={onSelect}
              onRename={onRenameSearch}
              onDelete={onDeleteSearch}
            />
          ))}
        </RailGroup>
      </div>

      {/* Account — pinned bottom */}
      <div className="shrink-0 w-full border-t border-border">
        <button
          onClick={onOpenSettings}
          title="Settings and API keys"
          className="group relative flex items-center h-[52px] w-full"
        >
          <span className="absolute left-[17px] w-9 h-9 flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[11px] font-medium">
            {userInitials || "··"}
          </span>
          <span
            className={cn(
              "absolute left-[62px] right-3 flex flex-col items-start text-left transition-opacity duration-200",
              expanded ? "opacity-100" : "opacity-0 pointer-events-none",
            )}
          >
            <span className="text-[13px] text-foreground truncate max-w-[150px]">
              {userEmail ?? "Your account"}
            </span>
            <span className="text-[11px] text-muted-foreground">Settings & API keys</span>
          </span>
        </button>
      </div>
    </aside>
  );
}

/* ── brand mark — monochrome OI tile, midday's flat square language ── */
function BrandMark() {
  return (
    <span className="w-[26px] h-[26px] shrink-0 grid place-items-center bg-primary">
      <span className="w-[10px] h-[10px] border-[1.5px] border-background" />
    </span>
  );
}

/* ── a single fixed rail item (icon + label, midday active pill) ── */
function RailItem({
  icon, label, expanded, active, badge, onClick,
}: {
  icon: React.ReactNode;
  label: string;
  expanded: boolean;
  active?: boolean;
  badge?: number;
  onClick?: () => void;
}) {
  return (
    <button onClick={onClick} title={label} className="group relative block h-[40px] w-full">
      {/* expanding active/hover pill */}
      <div
        className={cn(
          "absolute top-0 left-[15px] h-[40px] border border-transparent",
          "transition-all duration-200 ease-out",
          "group-hover:bg-accent",
          active && "bg-accent border-border",
          expanded ? "w-[calc(100%-30px)]" : "w-[40px]",
        )}
      />
      <div
        className={cn(
          "absolute top-0 left-[15px] w-[40px] h-[40px] flex items-center justify-center pointer-events-none",
          active ? "text-foreground" : "text-muted-foreground group-hover:text-foreground",
        )}
      >
        {icon}
      </div>
      {expanded && (
        <div className="absolute top-0 left-[55px] right-[10px] h-[40px] flex items-center pointer-events-none">
          <span
            className={cn(
              "text-sm font-medium whitespace-nowrap overflow-hidden",
              active ? "text-foreground" : "text-muted-foreground group-hover:text-foreground",
            )}
          >
            {label}
          </span>
          {badge !== undefined && (
            <span className="ml-auto min-w-[18px] h-[18px] px-1 grid place-items-center rounded-full bg-primary text-primary-foreground text-[10px] font-medium">
              {badge}
            </span>
          )}
        </div>
      )}
    </button>
  );
}

/* ── a rail group: an icon header whose children (dynamic rows) reveal
      when the rail is expanded — midday's Item→children pattern ── */
function RailGroup({
  icon, label, expanded, onAdd, addTitle, emptyMsg, children,
}: {
  icon: React.ReactNode;
  label: string;
  expanded: boolean;
  onAdd?: () => void;
  addTitle?: string;
  emptyMsg?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="group/section">
      <div className="relative h-[40px] w-full">
        <div className="absolute top-0 left-[15px] w-[40px] h-[40px] flex items-center justify-center text-muted-foreground pointer-events-none">
          {icon}
        </div>
        {expanded && (
          <div className="absolute top-0 left-[55px] right-[12px] h-[40px] flex items-center">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {label}
            </span>
            {onAdd && (
              <button
                onClick={onAdd}
                title={addTitle}
                className="ml-auto w-6 h-6 grid place-items-center rounded-[4px] text-muted-foreground hover:text-foreground hover:bg-accent"
              >
                <Icons.Add size={16} />
              </button>
            )}
          </div>
        )}
      </div>

      {expanded && (
        <div className="flex flex-col pb-1">
          {emptyMsg ? (
            <div className="ml-[35px] mr-[15px] pl-3 py-1 text-xs text-muted-foreground">{emptyMsg}</div>
          ) : (
            children
          )}
        </div>
      )}
    </div>
  );
}

/* ── a dynamic board / search row (rename + delete on hover) ── */
function ChildRow({
  entry, active, expanded, onSelect, onRename, onDelete,
}: {
  entry: NavEntry;
  active: boolean;
  expanded: boolean;
  onSelect: (id: string) => void;
  onRename?: (id: string, title: string) => void | Promise<void>;
  onDelete?: (id: string) => void | Promise<void>;
}) {
  const modal = useModal();
  const [renaming, setRenaming] = useState(false);
  const [value, setValue] = useState(entry.label);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setValue(entry.label); }, [entry.label]);
  useEffect(() => { if (renaming) { inputRef.current?.focus(); inputRef.current?.select(); } }, [renaming]);

  const commit = async () => {
    const next = value.trim();
    setRenaming(false);
    if (!next || next === entry.label) { setValue(entry.label); return; }
    try { await onRename?.(entry.id, next); } catch { setValue(entry.label); }
  };

  if (renaming) {
    return (
      <div className="ml-[35px] mr-[15px] border-l border-border pl-3 h-[32px] flex items-center">
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") { setValue(entry.label); setRenaming(false); }
          }}
          className="w-full bg-transparent text-xs text-foreground outline-none"
        />
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(entry.id)}
      onKeyDown={(e) => { if (e.key === "Enter") onSelect(entry.id); }}
      className="group/child ml-[35px] mr-[15px] border-l border-border pl-3 h-[32px] flex items-center cursor-pointer"
    >
      <span
        className={cn(
          "text-xs font-medium truncate transition-colors",
          active ? "text-foreground" : "text-muted-foreground group-hover/child:text-foreground",
        )}
      >
        {entry.label}
      </span>
      {expanded && (onRename || onDelete) && (
        <div
          className="ml-auto flex items-center gap-1 opacity-0 group-hover/child:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          {onRename && (
            <button
              title="Rename"
              onClick={(e) => { e.stopPropagation(); setRenaming(true); }}
              className="w-5 h-5 grid place-items-center rounded-[4px] text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              <PencilIcon />
            </button>
          )}
          {onDelete && (
            <button
              title="Delete"
              onClick={async (e) => {
                e.stopPropagation();
                const ok = await modal.confirm({
                  title: `Delete "${entry.label}"?`,
                  message: "This can't be undone.",
                  confirmLabel: "Delete",
                  destructive: true,
                });
                if (ok) onDelete(entry.id);
              }}
              className="w-5 h-5 grid place-items-center rounded-[4px] text-muted-foreground hover:text-destructive hover:bg-accent"
            >
              <Icons.Close size={12} />
            </button>
          )}
        </div>
      )}
      {entry.count > 0 && !expanded && (
        <span className="ml-auto text-[10px] text-muted-foreground">{entry.count}</span>
      )}
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
