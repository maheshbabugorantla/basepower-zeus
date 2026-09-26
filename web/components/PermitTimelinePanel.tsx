import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
} from "./ui/DataTable";
import { MissingState } from "./ui/MissingState";

// M2-P9 (web follow-up): Overview's "Time to permit a home battery in
// Austin" panel -- api.permit_path_stats, period_type='quarter',
// jurisdiction='ALL', label='battery', one row per quarter x
// is_base_power. `is_base_power=false` is every OTHER installer's
// battery permits that quarter (not "all installers combined" --
// Base's own permits are the separate is_base_power=true row), so the
// two columns are labelled "Other installers" and "Base Power", never
// "all installers", to avoid double-counting Base into its own
// comparison column.

export interface PermitQuarterRow {
  period: string;
  otherMedianDays: number | null;
  otherP90Days: number | null;
  otherN: number;
  baseMedianDays: number | null;
  baseP90Days: number | null;
  baseN: number;
}

export function PermitTimelinePanel({ rows }: { rows: PermitQuarterRow[] }) {
  if (rows.length === 0) {
    return <MissingState variant="not-loaded" reason="not published -- no permit-timeline figures yet" />;
  }
  return (
    <DataTable>
      <DataTableHead>
        <DataTableRow>
          <DataTableHeaderCell>Quarter</DataTableHeaderCell>
          <DataTableHeaderCell>Other installers: median (p90) days</DataTableHeaderCell>
          <DataTableHeaderCell>Base Power: median (p90) days</DataTableHeaderCell>
        </DataTableRow>
      </DataTableHead>
      <DataTableBody>
        {rows.map((r) => (
          <DataTableRow key={r.period}>
            <DataTableCell>
              <span style={{ fontFamily: "var(--type-data-font-family)" }}>{r.period}</span>
            </DataTableCell>
            <DataTableCell>
              {r.otherMedianDays === null ? (
                <span style={{ color: "var(--theme-ink-muted)" }}>not published</span>
              ) : (
                <span>
                  {r.otherMedianDays} ({r.otherP90Days ?? "—"}){" "}
                  <span style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>
                    n={r.otherN}
                  </span>
                </span>
              )}
            </DataTableCell>
            <DataTableCell>
              {r.baseMedianDays === null ? (
                <span style={{ color: "var(--theme-ink-muted)" }}>not published</span>
              ) : (
                <span>
                  {r.baseMedianDays} ({r.baseP90Days ?? "—"}){" "}
                  <span style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>
                    n={r.baseN}
                  </span>
                </span>
              )}
            </DataTableCell>
          </DataTableRow>
        ))}
      </DataTableBody>
    </DataTable>
  );
}
