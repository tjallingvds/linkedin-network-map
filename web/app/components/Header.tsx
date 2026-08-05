"use client";

/** Header — midday's top bar: a 70px-tall row, bottom hairline, breadcrumbs
 *  on the left. Crumbs derive from the route, and every crumb but the last
 *  is a real link. */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";

const LABELS: Record<string, string> = {
  "": "Contacts",
  overview: "Overview",
  search: "Search",
  settings: "Settings",
};

export function Header({ trailing }: { trailing?: string }) {
  const pathname = usePathname() ?? "/";

  const crumbs = useMemo(() => {
    const segs = pathname.split("/").filter(Boolean);
    const base = [{ href: "/", label: "CRM" }];
    if (segs.length === 0) return [...base, { href: "/", label: "Contacts" }];
    return [
      ...base,
      ...segs.map((s, i) => ({
        href: "/" + segs.slice(0, i + 1).join("/"),
        label: LABELS[s] ?? s.charAt(0).toUpperCase() + s.slice(1),
      })),
    ];
  }, [pathname]);

  const all = trailing ? [...crumbs, { href: pathname, label: trailing }] : crumbs;

  return (
    <header className="h-[70px] flex items-center justify-between border-b border-border px-4 md:px-8">
      <nav className="flex items-center gap-2 text-sm" aria-label="Breadcrumb">
        {all.map((c, i) => {
          const last = i === all.length - 1;
          return (
            <span key={`${c.href}-${i}`} className="flex items-center gap-2">
              {last ? (
                <span className="text-primary font-medium">{c.label}</span>
              ) : (
                <Link href={c.href} className="text-[#878787] hover:text-primary transition-colors">
                  {c.label}
                </Link>
              )}
              {!last && <span className="text-[#d0d0d0]">/</span>}
            </span>
          );
        })}
      </nav>
    </header>
  );
}
