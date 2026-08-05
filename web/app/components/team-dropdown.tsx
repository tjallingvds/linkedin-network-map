"use client";

/** midday's Sidebar pins a TeamDropdown to the bottom of the rail. The CRM has
 *  no teams, so this keeps midday's exact geometry (32x32 at left-[19px]
 *  bottom-4, label revealed at left-[62px]) and shows the signed-in account. */
import { useEffect, useState } from "react";
import { cn } from "@midday/ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@midday/ui/dropdown-menu";
import { api } from "@/lib/api";

export function TeamDropdown({ isExpanded = false }: { isExpanded?: boolean }) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .session()
      .then((r) => {
        if (!alive) return;
        setLabel(r.user?.name || r.user?.email || null);
      })
      .catch(() => {
        /* signed out — fall back to the placeholder */
      });
    return () => {
      alive = false;
    };
  }, []);

  const initials = (label ?? "")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .map((s) => s[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="relative h-[32px]">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={label ?? "Account"}
            className="fixed left-[19px] bottom-4 w-[32px] h-[32px] grid place-items-center bg-primary text-primary-foreground text-[11px] font-medium"
          >
            {initials || "··"}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-[200px]">
          <DropdownMenuItem disabled className="text-xs">
            {label ?? "Not signed in"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div
        className={cn(
          "fixed left-[62px] bottom-4 h-[32px] flex items-center transition-opacity duration-200",
          isExpanded ? "opacity-100" : "opacity-0 pointer-events-none",
        )}
      >
        <span className="text-xs text-[#878787] truncate max-w-[150px]">
          {label ?? "Your account"}
        </span>
      </div>
    </div>
  );
}
