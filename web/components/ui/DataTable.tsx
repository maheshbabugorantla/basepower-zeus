import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";

// DESIGN.md §1: tables are dense (36px rows) at the desk and scale with
// browser zoom for the projector. DESIGN.md §5 table-row-selected uses
// brand-subtle. These are structural primitives only — pages compose them
// with real rows from api.* views; no row data is ever hard-coded here.

export function DataTable({ children, className, ...rest }: HTMLAttributes<HTMLTableElement>) {
  return (
    <table {...rest} className={["data-table", className ?? ""].filter(Boolean).join(" ")}>
      {children}
    </table>
  );
}

export function DataTableHead({ children }: { children: ReactNode }) {
  return <thead>{children}</thead>;
}

export function DataTableBody({ children }: { children: ReactNode }) {
  return <tbody>{children}</tbody>;
}

export function DataTableRow({
  selected = false,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLTableRowElement> & { selected?: boolean }) {
  return (
    <tr
      {...rest}
      className={[
        selected ? "data-table__row--selected" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-selected={selected || undefined}
    >
      {children}
    </tr>
  );
}

export function DataTableHeaderCell({ children, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th {...rest}>{children}</th>;
}

export function DataTableCell({ children, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td {...rest}>{children}</td>;
}
