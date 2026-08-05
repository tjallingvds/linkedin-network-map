"use client";

/**
 * Column definitions — midday's `tables/customers/columns.tsx` structure kept
 * intact (memoised cell components, `meta.sticky` + `meta.className` sticky
 * config, size/minSize/maxSize, the trailing sticky Actions column with its
 * DropdownMenu), with the CRM's fields in place of midday's invoice-domain
 * ones. The table engine, header and row renderers around this are midday's
 * files unchanged.
 */
import { Avatar, AvatarFallback } from "@midday/ui/avatar";
import { Badge } from "@midday/ui/badge";
import { Button } from "@midday/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@midday/ui/dropdown-menu";
import { DotsHorizontalIcon } from "@radix-ui/react-icons";
import type { ColumnDef } from "@tanstack/react-table";
import { memo, useCallback } from "react";
import { useCustomerParams } from "@/hooks/use-customer-params";
import type { CrmContact } from "@/lib/types";

export type Customer = CrmContact;

function initials(name: string | null) {
  if (!name) return "";
  return name
    .split(" ")
    .map((s) => s[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function relativeTime(iso: string | null) {
  if (!iso) return "-";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "-";
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return `${Math.round(day / 30)}mo ago`;
}

const NameCell = memo(({ name }: { name: string | null }) => {
  if (!name) return "-";

  return (
    <div className="flex items-center space-x-2">
      <Avatar className="size-5">
        <AvatarFallback className="text-[9px] font-medium">
          {initials(name)}
        </AvatarFallback>
      </Avatar>
      <span className="truncate">{name}</span>
    </div>
  );
});

NameCell.displayName = "NameCell";

const EmailCell = memo(({ email }: { email: string | null }) => {
  if (!email) return "-";

  return (
    <a
      href={`mailto:${email}`}
      className="text-primary hover:underline truncate block"
      onClick={(e) => e.stopPropagation()}
    >
      {email}
    </a>
  );
});

EmailCell.displayName = "EmailCell";

const LinkedInCell = memo(({ url }: { url: string | null }) => {
  if (!url) return "-";

  const display = url
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "");

  return (
    <a
      href={url.startsWith("http") ? url : `https://${url}`}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary hover:underline truncate block"
      onClick={(e) => e.stopPropagation()}
    >
      {display}
    </a>
  );
});

LinkedInCell.displayName = "LinkedInCell";

const TouchCell = memo(
  ({ at, direction }: { at: string | null; direction: "in" | "out" | null }) => {
    if (!at) return "-";

    return (
      <div className="flex items-center space-x-1.5">
        <span className="text-[#878787]">{direction === "out" ? "↗" : "↘"}</span>
        <span>{relativeTime(at)}</span>
      </div>
    );
  },
);

TouchCell.displayName = "TouchCell";

const ActionsCell = memo(
  ({
    contactId,
    onDelete,
  }: {
    contactId: string;
    onDelete?: (id: string) => void;
  }) => {
    const { setParams } = useCustomerParams();

    const handleEdit = useCallback(() => {
      setParams({ customerId: contactId });
    }, [contactId, setParams]);

    const handleDelete = useCallback(() => {
      onDelete?.(contactId);
    }, [contactId, onDelete]);

    return (
      <div className="flex items-center justify-center w-full">
        <DropdownMenu>
          <DropdownMenuTrigger asChild className="relative">
            <Button variant="ghost" className="h-8 w-8 p-0">
              <DotsHorizontalIcon className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={handleEdit}>Edit contact</DropdownMenuItem>
            <DropdownMenuItem onClick={handleDelete} className="text-[#FF3638]">
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  },
);

ActionsCell.displayName = "ActionsCell";

export const columns: ColumnDef<Customer>[] = [
  {
    id: "name",
    accessorKey: "name",
    header: "Name",
    size: 320,
    minSize: 240,
    maxSize: 500,
    enableResizing: true,
    meta: {
      sticky: true,
      skeleton: { type: "avatar-text", width: "w-32" },
      headerLabel: "Name",
      className:
        "w-[320px] min-w-[240px] md:sticky md:left-0 bg-background group-hover:bg-[#F2F1EF] group-hover:dark:bg-[#0f0f0f] z-20",
    },
    cell: ({ row }) => <NameCell name={row.original.name} />,
  },
  {
    id: "title",
    accessorKey: "title",
    header: "Title",
    size: 220,
    minSize: 160,
    maxSize: 400,
    enableResizing: true,
    meta: {
      skeleton: { type: "text", width: "w-24" },
      headerLabel: "Title",
      className: "w-[220px] min-w-[160px]",
    },
    cell: ({ row }) => row.original.title ?? "-",
  },
  {
    id: "company",
    accessorKey: "company",
    header: "Company",
    size: 220,
    minSize: 160,
    maxSize: 400,
    enableResizing: true,
    meta: {
      skeleton: { type: "text", width: "w-24" },
      headerLabel: "Company",
      className: "w-[220px] min-w-[160px]",
    },
    cell: ({ row }) => row.original.company ?? "-",
  },
  {
    id: "email",
    accessorKey: "email",
    header: "Email",
    size: 280,
    minSize: 220,
    maxSize: 450,
    enableResizing: true,
    meta: {
      skeleton: { type: "text", width: "w-32" },
      headerLabel: "Email",
      className: "w-[280px] min-w-[220px]",
    },
    cell: ({ row }) => <EmailCell email={row.original.email} />,
  },
  {
    id: "stage",
    accessorKey: "stage",
    header: "Stage",
    size: 140,
    minSize: 110,
    maxSize: 200,
    enableResizing: true,
    meta: {
      skeleton: { type: "text", width: "w-16" },
      headerLabel: "Stage",
      className: "w-[140px] min-w-[110px]",
    },
    cell: ({ row }) => (
      <Badge variant="tag" className="whitespace-nowrap capitalize">
        {row.original.stage}
      </Badge>
    ),
  },
  {
    id: "lastTouch",
    accessorKey: "lastTouchAt",
    header: "Last touch",
    size: 160,
    minSize: 120,
    maxSize: 220,
    enableResizing: true,
    meta: {
      skeleton: { type: "text", width: "w-20" },
      headerLabel: "Last touch",
      className: "w-[160px] min-w-[120px]",
    },
    cell: ({ row }) => (
      <TouchCell
        at={row.original.lastTouchAt}
        direction={row.original.lastTouchDirection}
      />
    ),
  },
  {
    id: "linkedin",
    accessorKey: "linkedin",
    header: "LinkedIn",
    size: 220,
    minSize: 160,
    maxSize: 320,
    enableResizing: true,
    meta: {
      skeleton: { type: "text", width: "w-28" },
      headerLabel: "LinkedIn",
      className: "w-[220px] min-w-[160px]",
    },
    cell: ({ row }) => <LinkedInCell url={row.original.linkedin} />,
  },
  {
    id: "sent",
    accessorKey: "sent",
    header: "Sent",
    size: 110,
    minSize: 90,
    maxSize: 160,
    enableResizing: true,
    meta: {
      skeleton: { type: "text", width: "w-8" },
      headerLabel: "Sent",
      className: "w-[110px] min-w-[90px]",
    },
    cell: ({ row }) => row.original.sent ?? 0,
  },
  {
    id: "actions",
    header: "Actions",
    size: 100,
    minSize: 100,
    maxSize: 100,
    enableResizing: false,
    enableSorting: false,
    enableHiding: false,
    meta: {
      sticky: true,
      skeleton: { type: "icon" },
      headerLabel: "Actions",
      className:
        "text-right sticky right-0 bg-background group-hover:bg-[#F2F1EF] group-hover:dark:bg-[#0f0f0f] z-30 justify-center !border-l !border-border",
    },
    cell: ({ row, table }) => (
      <ActionsCell
        contactId={row.original.id}
        onDelete={table.options.meta?.deleteCustomer}
      />
    ),
  },
];
