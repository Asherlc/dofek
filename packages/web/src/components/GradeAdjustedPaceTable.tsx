import { formatNumber, formatPace } from "@dofek/format/format";
import type { GradeAdjustedPaceRow } from "dofek-server/types";
import { useUnitConverter } from "../lib/unitContext.ts";
import { ActivityTable, type ActivityTableColumn } from "./ActivityTable.tsx";

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

  const columns: ActivityTableColumn<GradeAdjustedPaceRow>[] = [
    {
      key: "date",
      label: "Date",
      headerClassName: "pb-2 pr-4",
      cellClassName: "py-2 pr-4 text-foreground",
      renderCell: (row) => new Date(row.date).toLocaleDateString(),
    },
    {
      key: "name",
      label: "Name",
      headerClassName: "pb-2 pr-4",
      cellClassName: "py-2 pr-4 text-foreground",
      renderCell: (row) => row.activityName,
    },
    {
      key: "distance",
      label: "Distance",
      headerClassName: "pb-2 pr-4",
      cellClassName: "py-2 pr-4 tabular-nums",
      renderCell: (row) =>
        `${formatNumber(units.convertDistance(row.distanceKm))} ${units.distanceLabel}`,
    },
    {
      key: "duration",
      label: "Duration",
      headerClassName: "pb-2 pr-4",
      cellClassName: "py-2 pr-4 tabular-nums",
      renderCell: (row) => `${formatNumber(row.durationMinutes, 0)} min`,
    },
    {
      key: "pace",
      label: "Pace",
      headerClassName: "pb-2 pr-4",
      cellClassName: "py-2 pr-4 tabular-nums",
      renderCell: (row) =>
        `${formatPace(units.convertPace(row.averagePaceMinPerKm * 60))} ${units.paceLabel}`,
    },
    {
      key: "gap",
      label: "GAP",
      headerClassName: "pb-2 pr-4",
      cellClassName: "py-2 pr-4 tabular-nums",
      renderCell: (row) => {
        const paceDiffPct =
          row.averagePaceMinPerKm > 0
            ? Math.abs(row.gradeAdjustedPaceMinPerKm - row.averagePaceMinPerKm) /
              row.averagePaceMinPerKm
            : 0;
        const highlightGap = paceDiffPct > 0.15;
        const value = `${formatPace(units.convertPace(row.gradeAdjustedPaceMinPerKm * 60))} ${units.paceLabel}`;
        return highlightGap ? <span className="text-amber-400 font-medium">{value}</span> : value;
      },
    },
    {
      key: "elevGain",
      label: "Elev Gain",
      headerClassName: "pb-2",
      cellClassName: "py-2 tabular-nums",
      renderCell: (row) =>
        `${Math.round(units.convertElevation(row.elevationGainMeters))} ${units.elevationLabel}`,
    },
  ];

  return (
    <div>
      <h3 className="text-xs font-medium text-subtle mb-2">Grade-Adjusted Pace</h3>
      <ActivityTable
        rows={data}
        columns={columns}
        getRowKey={(row) => `${row.activityId}-${row.date}-${row.activityName}`}
        getActivityId={(row) => row.activityId}
      />
      <p className="text-xs text-dim mt-1">
        GAP highlighted in amber when it differs from actual pace by more than 15%.
      </p>
    </div>
  );
}
