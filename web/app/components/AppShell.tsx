"use client";

/** AppShell — midday's dashboard frame, verbatim:
 *    <Sidebar />  +  <div className="md:ml-[70px] pb-4"> … </div>
 *  (apps/dashboard/src/app/[locale]/(app)/(sidebar)/layout.tsx) */
import type { ReactNode } from "react";
import { Sidebar } from "./sidebar";
import { Toaster } from "./midday/toaster";

export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative">
      <Sidebar />

      <div className="md:ml-[70px] pb-4">{children}</div>

      <Toaster />
    </div>
  );
}
