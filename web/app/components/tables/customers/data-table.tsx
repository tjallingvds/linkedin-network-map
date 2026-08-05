"use client";

/**
 * midday's actual customers DataTable (apps/dashboard/src/components/tables/
 * customers/data-table.tsx), with ONLY the data plumbing swapped: tRPC infinite
 * query + Supabase realtime + OpenPanel tracking are replaced by rows passed in
 * from the CRM API. Everything below — the table setup, virtualiser, sticky
 * columns, DnD, and the entire render — is midday's code unchanged.
 */
import { closestCenter, DndContext } from "@dnd-kit/core";
import { Table, TableBody, TableCell, TableRow } from "@midday/ui/table";
import { getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { useCallback, useMemo, useRef } from "react";
import { VirtualRow } from "@/components/tables/core";
import { useScrollHeader } from "@/hooks/use-scroll-header";
import { useStickyColumns } from "@/hooks/use-sticky-columns";
import { useTableDnd } from "@/hooks/use-table-dnd";
import { useTableScroll } from "@/hooks/use-table-scroll";
import { useTableSettings } from "@/hooks/use-table-settings";
import { STICKY_COLUMNS, SUMMARY_GRID_HEIGHTS } from "@/utils/table-configs";
import { getColumnIds, type TableSettings } from "@/utils/table-settings";
import type { CrmContact } from "@/lib/types";
import { columns } from "./columns";
import { EmptyState, NoResults } from "./empty-states";
import { DataTableHeader } from "./table-header";

// Stable reference for non-clickable columns (avoids recreation on each render)
const NON_CLICKABLE_COLUMNS = new Set(["actions"]);

const COLUMN_IDS = getColumnIds(columns);

type Props = {
  initialSettings?: Partial<TableSettings>;
  /** Rows from the CRM API (replaces midday's tRPC infinite query). */
  data: CrmContact[];
  hasFilters?: boolean;
  onOpen?: (id?: string) => void;
  onDelete?: (id: string) => void;
};

export function DataTable({
  initialSettings,
  data,
  hasFilters = false,
  onOpen,
  onDelete,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);

  // Hide header and summary grid on scroll
  useScrollHeader(parentRef, { extraOffset: SUMMARY_GRID_HEIGHTS.customers });

  // Use unified table settings hook for column state management
  const {
    columnVisibility,
    setColumnVisibility,
    columnSizing,
    setColumnSizing,
    columnOrder,
    setColumnOrder,
  } = useTableSettings({
    tableId: "customers",
    initialSettings,
    columnIds: COLUMN_IDS,
  });

  const tableData = data;

  const setOpen = useCallback(
    (id?: string) => {
      onOpen?.(id);
    },
    [onOpen],
  );

  const tableMeta = useMemo(
    () => ({
      deleteCustomer: onDelete,
    }),
    [onDelete],
  );

  const table = useReactTable({
    data: tableData,
    getRowId: (row) => row.id,
    columns,
    getCoreRowModel: getCoreRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
    enableColumnResizing: true,
    columnResizeMode: "onChange",
    onColumnSizingChange: setColumnSizing,
    onColumnOrderChange: setColumnOrder,
    state: {
      columnVisibility,
      columnSizing,
      columnOrder,
    },
    meta: tableMeta,
  });

  // DnD for column reordering
  const { sensors, handleDragEnd } = useTableDnd(table);

  // Use the reusable sticky columns hook
  const { getStickyStyle, getStickyClassName } = useStickyColumns({
    columnVisibility,
    table,
    stickyColumns: STICKY_COLUMNS.customers,
  });

  // Use the reusable table scroll hook
  const tableScroll = useTableScroll({
    useColumnWidths: true,
    startFromColumn: 1, // Skip sticky name column
  });

  const rows = table.getRowModel().rows;

  // Row virtualizer for performance
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 45,
    overscan: 10,
  });

  if (!tableData.length && hasFilters) {
    return <NoResults />;
  }

  if (!tableData.length) {
    return <EmptyState />;
  }

  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div className="relative">
      <div className="w-full">
        <div
          ref={(el) => {
            if (parentRef) {
              (
                parentRef as React.MutableRefObject<HTMLDivElement | null>
              ).current = el;
            }
            if (tableScroll.containerRef) {
              (
                tableScroll.containerRef as React.MutableRefObject<HTMLDivElement | null>
              ).current = el;
            }
          }}
          className="overflow-auto overscroll-contain border-l border-r border-b border-border scrollbar-hide"
          style={{
            height: "calc(100vh - 350px + var(--header-offset, 0px))",
          }}
        >
          <DndContext
            id="customers-table-dnd"
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <Table className="w-full min-w-full">
              <DataTableHeader table={table} tableScroll={tableScroll} />

              <TableBody
                className="border-l-0 border-r-0 block"
                style={{
                  height: `${rowVirtualizer.getTotalSize()}px`,
                  position: "relative",
                }}
              >
                {virtualItems.length > 0 ? (
                  virtualItems.map((virtualRow: VirtualItem) => {
                    const row = rows[virtualRow.index];
                    if (!row) return null;

                    return (
                      <VirtualRow
                        key={row.id}
                        row={row}
                        virtualStart={virtualRow.start}
                        rowHeight={45}
                        getStickyStyle={getStickyStyle}
                        getStickyClassName={getStickyClassName}
                        nonClickableColumns={NON_CLICKABLE_COLUMNS}
                        onCellClick={setOpen}
                        columnSizing={columnSizing}
                        columnOrder={columnOrder}
                        columnVisibility={columnVisibility}
                      />
                    );
                  })
                ) : (
                  <TableRow>
                    <TableCell
                      colSpan={columns.length}
                      className="h-24 text-center"
                    >
                      No results.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </DndContext>
          {/* Spacer ensures scrolling works when content barely overflows */}
          <div
            style={{ height: "var(--header-offset, 0px)", flexShrink: 0 }}
            aria-hidden
          />
        </div>
      </div>
    </div>
  );
}
