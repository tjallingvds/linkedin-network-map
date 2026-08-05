"use client";

/** Contacts — the CRM's contacts rendered in midday's real dashboard page
 *  shape: header + breadcrumb, a filter row, and midday's <Table>. Data comes
 *  from the existing Express CRM API through the same-origin rewrite. */
import { useEffect, useMemo, useState } from "react";
import { api } from "./lib/api";
import type { CrmBoard, CrmContact, CrmStageDef } from "./lib/types";
import { Header } from "./components/Header";
import { Avatar, AvatarFallback } from "./components/midday/avatar";
import { Badge } from "./components/midday/badge";
import { Input } from "./components/midday/input";
import { Skeleton } from "./components/midday/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/midday/table";
import { cn } from "./lib/cn";

function initials(name: string) {
  return name
    .split(" ")
    .map((s) => s[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function relativeTime(iso: string | null) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = Date.now() - t;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return `${Math.round(day / 30)}mo ago`;
}

export default function ContactsPage() {
  const [boards, setBoards] = useState<CrmBoard[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [contacts, setContacts] = useState<CrmContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    let alive = true;
    api
      .boards()
      .then((r) => {
        if (!alive) return;
        setBoards(r.boards ?? []);
        setActiveId((cur) => cur ?? r.boards?.[0]?.id ?? null);
      })
      .catch((e) => alive && setError(String(e.message ?? e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!activeId) return;
    let alive = true;
    setLoading(true);
    api
      .contacts(activeId)
      .then((r) => alive && setContacts(r.contacts ?? []))
      .catch((e) => alive && setError(String(e.message ?? e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [activeId]);

  const board = boards.find((b) => b.id === activeId) ?? null;

  const stageById = useMemo(() => {
    const map = new Map<string, CrmStageDef>();
    (board?.stages ?? []).forEach((s) => map.set(s.id, s));
    return map;
  }, [board]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return contacts;
    return contacts.filter((c) =>
      [c.name, c.company, c.title, c.email]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(needle)),
    );
  }, [contacts, q]);

  return (
    <>
      <Header trailing={board?.name} />

      <div className="px-4 md:px-8 pt-6">
        {/* Board switcher + search */}
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <div className="flex items-center gap-1">
            {boards.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => setActiveId(b.id)}
                className={cn(
                  "h-9 px-3 text-sm border transition-colors",
                  b.id === activeId
                    ? "bg-[#f7f7f7] dark:bg-[#131313] border-[#e6e6e6] dark:border-[#1d1d1d] text-primary"
                    : "border-transparent text-[#878787] hover:text-primary",
                )}
              >
                {b.name}
              </button>
            ))}
          </div>
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search contacts…"
            className="h-9 w-full max-w-[320px]"
          />
          <span className="ml-auto text-sm text-[#878787]">
            {rows.length} {rows.length === 1 ? "contact" : "contacts"}
          </span>
        </div>

        {error && (
          <div className="border border-border p-4 text-sm text-[#878787] mb-4">
            {error.includes("401")
              ? "Not signed in — open the app and sign in, then reload."
              : error}
          </div>
        )}

        <div className="border border-border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[280px]">Name</TableHead>
                <TableHead className="w-[200px]">Title</TableHead>
                <TableHead className="w-[200px]">Company</TableHead>
                <TableHead className="w-[240px]">Email</TableHead>
                <TableHead className="w-[130px]">Stage</TableHead>
                <TableHead className="w-[140px]">Last touch</TableHead>
                <TableHead className="w-[90px] text-center">Sent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading &&
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={`sk-${i}`} className="h-[45px]">
                    {Array.from({ length: 7 }).map((__, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-24" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}

              {!loading &&
                rows.map((c) => {
                  const stage = stageById.get(c.stage);
                  return (
                    <TableRow
                      key={c.id}
                      className="h-[45px] cursor-pointer hover:bg-[#F2F1EF] dark:hover:bg-[#0f0f0f]"
                    >
                      <TableCell>
                        <div className="flex items-center space-x-2">
                          <Avatar className="size-5">
                            <AvatarFallback className="text-[9px] font-medium">
                              {initials(c.name)}
                            </AvatarFallback>
                          </Avatar>
                          <span className="truncate">{c.name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-[#878787]">{c.title ?? "—"}</TableCell>
                      <TableCell>{c.company ?? "—"}</TableCell>
                      <TableCell>
                        {c.email ? (
                          <a
                            href={`mailto:${c.email}`}
                            className="text-primary hover:underline truncate block"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {c.email}
                          </a>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="tag" className="whitespace-nowrap">
                          {stage?.label ?? c.stage}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-[#878787]">
                        {relativeTime(c.lastTouchAt)}
                      </TableCell>
                      <TableCell className="text-center tabular-nums">{c.sent ?? 0}</TableCell>
                    </TableRow>
                  );
                })}

              {!loading && rows.length === 0 && !error && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={7} className="h-24 text-center text-[#878787]">
                    No contacts yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </>
  );
}
