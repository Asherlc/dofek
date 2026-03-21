import type { GradeAdjustedPaceRow } from "dofek-server/types";
import { formatPace } from "../lib/format.ts";
import { useUnitSystem } from "../lib/unitContext.ts";
import {
  convertDistance,
  convertElevation,
  convertPace,
  distanceLabel,
  elevationLabel,
  paceLabel,
} from "../lib/units.ts";

interface GradeAdjustedPaceTableProps {
  data: GradeAdjustedPaceRow[];
  loading?: boolean;
}

export function GradeAdjustedPaceTable({ data, loading }: GradeAdjustedPaceTableProps) {
  const { unitSystem } = useUnitSystem();
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
                    {convertDistance(row.distanceKm, unitSystem).toFixed(1)}{" "}
                    {distanceLabel(unitSystem)}
                  </td>
                  <td className="py-2 pr-4 tabular-nums">{row.durationMinutes.toFixed(0)} min</td>
                  <td className="py-2 pr-4 tabular-nums">
                    {formatPace(convertPace(row.averagePaceMinPerKm * 60, unitSystem))}{" "}
                    {paceLabel(unitSystem)}
                  </td>
                  <td
                    className={`py-2 pr-4 tabular-nums ${highlightGap ? "text-amber-400 font-medium" : ""}`}
                  >
                    {formatPace(convertPace(row.gradeAdjustedPaceMinPerKm * 60, unitSystem))}{" "}
                    {paceLabel(unitSystem)}
                  </td>
                  <td className="py-2 tabular-nums">
                    {Math.round(convertElevation(row.elevationGainMeters, unitSystem))}{" "}
                    {elevationLabel(unitSystem)}
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
