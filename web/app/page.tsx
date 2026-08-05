"use client";

/** Contacts — renders midday's actual customers DataTable (its virtualiser,
 *  sticky columns, resizable + drag-reorderable headers, settings persistence)
 *  against the CRM's boards/contacts from the existing Express API. */
import { useEffect, useMemo, useState } from "react";
import { Header } from "./components/Header";
import { DataTable } from "./components/tables/customers/data-table";
import { Input } from "./components/midday/input";
import { api } from "./lib/api";
import { cn } from "./lib/cn";
import type { CrmBoard, CrmContact } from "./lib/types";

export default function ContactsPage() {
  const [boards, setBoards] = useState<CrmBoard[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [contacts, setContacts] = useState<CrmContact[]>([]);
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
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!activeId) return;
    let alive = true;
    api
      .contacts(activeId)
      .then((r) => alive && setContacts(r.contacts ?? []))
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [activeId]);

  const board = boards.find((b) => b.id === activeId) ?? null;

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return contacts;
    return contacts.filter((c) =>
      [c.name, c.company, c.title, c.email]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(needle)),
    );
  }, [contacts, q]);

  const handleDelete = (id: string) => {
    setContacts((cur) => cur.filter((c) => c.id !== id));
  };

  return (
    <>
      <Header trailing={board?.name} />

      <div className="px-4 md:px-8 pt-6">
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
              ? "Not signed in — sign in to the app, then reload."
              : error}
          </div>
        )}

        <DataTable
          data={rows}
          hasFilters={q.trim().length > 0}
          onDelete={handleDelete}
        />
      </div>
    </>
  );
}
