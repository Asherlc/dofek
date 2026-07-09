import type { ClimbingSessionSummaryRow } from "dofek-server/types";
import { ActivityTable, type ActivityTableColumn } from "./ActivityTable.tsx";

interface ClimbingSessionSummaryTableProps {
  data: ClimbingSessionSummaryRow[];
}

class ClimbingSessionSummaryTableModel {
  readonly #rows: ClimbingSessionSummaryRow[];

  constructor(rows: ClimbingSessionSummaryRow[]) {
    this.#rows = rows;
  }

  get rows(): ClimbingSessionSummaryRow[] {
    return this.#rows;
  }

  columns(): Array<ActivityTableColumn<ClimbingSessionSummaryRow>> {
    return [
      {
        key: "session",
        label: "Session",
        cellClassName: "py-2 pr-4",
        renderCell: (row) => (
          <div>
            <div className="font-medium text-foreground">{row.name}</div>
            <div className="text-xs text-dim">{row.locationName ?? row.date}</div>
          </div>
        ),
      },
      {
        key: "attempts",
        label: "Attempts",
        cellClassName: "py-2 pr-4 text-muted",
        renderCell: (row) => row.attempts,
      },
      {
        key: "sends",
        label: "Sends",
        cellClassName: "py-2 pr-4 text-muted",
        renderCell: (row) => row.sends,
      },
      {
        key: "boulder",
        label: "Best Boulder Grade",
        cellClassName: "py-2 pr-4 text-muted",
        renderCell: (row) => row.hardestBoulderGrade ?? "None",
      },
      {
        key: "route",
        label: "Best Route Grade",
        cellClassName: "py-2 text-muted",
        renderCell: (row) => row.hardestRouteGrade ?? "None",
      },
    ];
  }
}

export function ClimbingSessionSummaryTable({ data }: ClimbingSessionSummaryTableProps) {
  const model = new ClimbingSessionSummaryTableModel(data);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="text-sm text-dim">No climbing sessions</span>
      </div>
    );
  }

  return (
    <ActivityTable
      rows={model.rows}
      columns={model.columns()}
      getRowKey={(row) => row.activityId}
      getActivityId={(row) => row.activityId}
    />
  );
}
