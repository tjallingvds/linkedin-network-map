"use client";

/**
 * Sidebar — ported from midday-ai/midday's `apps/dashboard` Sidebar + MainMenu.
 * A fixed 70px icon rail that expands to 240px; the 70px logo box, the
 * expanding active pill, the icon-at-left-[15px] / label-at-left-[55px]
 * geometry and the pinned-bottom account row are midday's, verbatim in spirit.
 * A pin toggle is added so the rail can be kept open.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { cn } from "../lib/cn";
import { Logo } from "./Logo";
import {
  MdOutlineDashboard,
  MdOutlinePeopleAlt,
  MdOutlineSearch,
  MdOutlineSettings,
  MdOutlineViewSidebar,
} from "react-icons/md";

const items = [
  { path: "/", name: "Contacts", icon: MdOutlinePeopleAlt },
  { path: "/overview", name: "Overview", icon: MdOutlineDashboard },
  { path: "/search", name: "Search", icon: MdOutlineSearch },
  { path: "/settings", name: "Settings", icon: MdOutlineSettings },
];

export function Sidebar({
  userLabel,
  pinned,
  onTogglePin,
}: {
  userLabel?: string;
  /** Pinned open — the content column offsets by 240px. A hover only peeks. */
  pinned: boolean;
  onTogglePin: () => void;
}) {
  const pathname = usePathname() ?? "/";
  const [hovering, setHovering] = useState(false);
  const isExpanded = pinned || hovering;

  return (
    <aside
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      className={cn(
        "h-screen flex-shrink-0 flex-col justify-between fixed top-0 left-0 pb-4",
        "hidden md:flex z-50 overflow-hidden bg-background border-r border-border",
        "transition-all duration-200 ease-out",
        isExpanded ? "w-[240px]" : "w-[70px]",
      )}
    >
      {/* 70px logo box — midday's brand header */}
      <div
        className={cn(
          "absolute top-0 left-0 h-[70px] flex items-center bg-background border-b border-border",
          "transition-all duration-200 ease-out",
          isExpanded ? "w-full" : "w-[69px]",
        )}
      >
        <Link href="/" className="absolute left-[21px] text-primary">
          <Logo size={26} />
        </Link>
        <span
          className={cn(
            "absolute left-[62px] whitespace-nowrap text-sm font-medium text-primary transition-opacity duration-200",
            isExpanded ? "opacity-100" : "opacity-0",
          )}
        >
          Observable Intuition
        </span>
        <button
          type="button"
          onClick={onTogglePin}
          title={pinned ? "Collapse sidebar" : "Keep sidebar open"}
          aria-label={pinned ? "Collapse sidebar" : "Keep sidebar open"}
          className={cn(
            "absolute right-[14px] w-7 h-7 grid place-items-center",
            "text-[#878787] hover:text-primary hover:bg-accent transition-opacity duration-200",
            isExpanded ? "opacity-100" : "opacity-0 pointer-events-none",
          )}
        >
          <MdOutlineViewSidebar size={16} />
        </button>
      </div>

      {/* Menu */}
      <div className="flex flex-col w-full pt-[70px] flex-1 border-b border-border mb-3">
        <nav className="mt-4 w-full">
          <div className="flex flex-col gap-2">
            {items.map((item) => {
              const isActive =
                item.path === "/" ? pathname === "/" : pathname.startsWith(item.path);
              const Icon = item.icon;
              return (
                <Link key={item.path} href={item.path} className="group">
                  <div className="relative">
                    {/* the expanding background — midday's active pill */}
                    <div
                      className={cn(
                        "border border-transparent h-[40px] ml-[15px] mr-[15px]",
                        "transition-all duration-200 ease-out",
                        isActive && "bg-[#f7f7f7] dark:bg-[#131313] border-[#e6e6e6] dark:border-[#1d1d1d]",
                        isExpanded ? "w-[calc(100%-30px)]" : "w-[40px]",
                      )}
                    />
                    <div className="absolute top-0 left-[15px] w-[40px] h-[40px] flex items-center justify-center text-black dark:text-[#666666] group-hover:!text-primary pointer-events-none">
                      <Icon size={20} />
                    </div>
                    {isExpanded && (
                      <div className="absolute top-0 left-[55px] right-[4px] h-[40px] flex items-center pointer-events-none">
                        <span
                          className={cn(
                            "text-sm font-medium whitespace-nowrap overflow-hidden",
                            "text-[#666] group-hover:text-primary",
                            isActive && "text-primary",
                          )}
                        >
                          {item.name}
                        </span>
                      </div>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        </nav>
      </div>

      {/* Account — midday pins this to the bottom of the rail */}
      <div className="relative h-[32px] w-full">
        <div className="absolute left-[19px] bottom-0 w-[32px] h-[32px] grid place-items-center bg-primary text-primary-foreground text-[11px] font-medium">
          {(userLabel ?? "··").slice(0, 2).toUpperCase()}
        </div>
        {isExpanded && (
          <div className="absolute left-[62px] bottom-0 h-[32px] flex items-center">
            <span className="text-xs text-[#878787] truncate max-w-[150px]">
              {userLabel ?? "Your account"}
            </span>
          </div>
        )}
      </div>
    </aside>
  );
}
