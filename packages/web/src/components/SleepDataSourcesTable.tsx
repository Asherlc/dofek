import { formatDateMedium, formatDurationMinutes } from "@dofek/format/format";
import { formatSleepProvenance } from "../lib/sleepSource.ts";

export interface SleepDataSourceRow {
  date: string;
  durationMinutes: number | null;
  providerId: string | null;
  sourceName: string | null;
  sourceProviders: string[];
}

interface SleepDataSourcesTableProps {
  rows: SleepDataSourceRow[];
  loading?: boolean;
}

export function SleepDataSourcesTable({ rows, loading }: SleepDataSourcesTableProps) {
  if (loading) {
    return (
      <div className="animate-pulse space-y-2">
        {["a", "b", "c"].map((id) => (
          <div key={id} className="h-8 bg-surface-solid rounded" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return <p className="text-sm text-dim py-2">No sleep data in this range.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-subtle border-b border-border">
            <th className="pb-2 pr-4 font-medium">Night</th>
            <th className="pb-2 pr-4 font-medium">Duration</th>
            <th className="pb-2 pr-4 font-medium">Source</th>
            <th className="pb-2 font-medium">Also reported by</th>
          </tr>
        </thead>
        <tbody>
          {[...rows].reverse().map((row) => {
            const { primary, alsoFrom } = formatSleepProvenance(row);
            return (
              <tr key={row.date} className="border-b border-border/40 last:border-0">
                <td className="py-2 pr-4 text-foreground whitespace-nowrap">
                  {formatDateMedium(row.date)}
                </td>
                <td className="py-2 pr-4 text-muted tabular-nums whitespace-nowrap">
                  {row.durationMinutes != null
                    ? formatDurationMinutes(row.durationMinutes)
                    : "—"}
                </td>
                <td className="py-2 pr-4 text-foreground whitespace-nowrap">{primary}</td>
                <td className="py-2 text-subtle text-xs whitespace-nowrap">{alsoFrom ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
