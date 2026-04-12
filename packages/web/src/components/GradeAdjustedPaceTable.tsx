import { formatNumber, formatPace } from "@dofek/format/format";
import type { GradeAdjustedPaceRow } from "dofek-server/types";
import { useUnitConverter } from "../lib/unitContext.ts";

interface GradeAdjustedPaceTableProps {
  data: GradeAdjustedPaceRow[];
  loading?: boolean;
}

export function GradeAdjustedPaceTable({ data, loading }: GradeAdjustedPaceTableProps) {
  const units = useUnitConverter();
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[200px]">
        <span className="text-dim text-sm">Loading grade-adjusted pace data...</span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[100px]">
        <span className="text-dim text-sm">No hiking/walking activities found</span>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-xs font-medium text-subtle mb-2">Grade-Adjusted Pace</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted uppercase tracking-wider">
              <th className="pb-2 pr-4">Date</th>
              <th className="pb-2 pr-4">Name</th>
              <th className="pb-2 pr-4">Distance</th>
              <th className="pb-2 pr-4">Duration</th>
              <th className="pb-2 pr-4">Pace</th>
              <th className="pb-2 pr-4">GAP</th>
              <th className="pb-2">Elev Gain</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => {
              const paceDiffPct =
                row.averagePaceMinPerKm > 0
                  ? Math.abs(row.gradeAdjustedPaceMinPerKm - row.averagePaceMinPerKm) /
                    row.averagePaceMinPerKm
                  : 0;
              const highlightGap = paceDiffPct > 0.15;

              return (
                <tr
                  key={`${row.date}-${row.activityName}`}
                  className="border-b border-border/50 hover:bg-surface-hover"
                >
                  <td className="py-2 pr-4 text-foreground">
                    {new Date(row.date).toLocaleDateString()}
                  </td>
                  <td className="py-2 pr-4 text-foreground">{row.activityName}</td>
                  <td className="py-2 pr-4 tabular-nums">
                    {formatNumber(units.convertDistance(row.distanceKm))} {units.distanceLabel}
                  </td>
                  <td className="py-2 pr-4 tabular-nums">
                    {formatNumber(row.durationMinutes, 0)} min
                  </td>
                  <td className="py-2 pr-4 tabular-nums">
                    {formatPace(units.convertPace(row.averagePaceMinPerKm * 60))} {units.paceLabel}
                  </td>
                  <td
                    className={`py-2 pr-4 tabular-nums ${highlightGap ? "text-amber-400 font-medium" : ""}`}
                  >
                    {formatPace(units.convertPace(row.gradeAdjustedPaceMinPerKm * 60))}{" "}
                    {units.paceLabel}
                  </td>
                  <td className="py-2 tabular-nums">
                    {Math.round(units.convertElevation(row.elevationGainMeters))}{" "}
                    {units.elevationLabel}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-dim mt-1">
        GAP highlighted in amber when it differs from actual pace by more than 15%.
      </p>
    </div>
  );
}
