"use client";

/** AppShell — midday's dashboard frame: fixed rail + an offset content column
 *  holding the header and the page. (midday: `<Sidebar/>` + `md:ml-[70px]`.) */
import { useState, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { Sidebar } from "./Sidebar";
import { Toaster } from "./midday/toaster";

export default function AppShell({ children }: { children: ReactNode }) {
  const [pinned, setPinned] = useState(true);

  return (
    <div className="relative">
      <Sidebar pinned={pinned} onTogglePin={() => setPinned((p) => !p)} />
      <div
        className={cn(
          "pb-4 transition-all duration-200 ease-out",
          pinned ? "md:ml-[240px]" : "md:ml-[70px]",
        )}
      >
        {children}
      </div>
      <Toaster />
    </div>
  );
}
