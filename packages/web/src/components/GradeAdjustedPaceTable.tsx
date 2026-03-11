export interface GradeAdjustedPaceRow {
  date: string;
  activityName: string;
  distanceKm: number;
  durationMinutes: number;
  averagePaceMinPerKm: number;
  gradeAdjustedPaceMinPerKm: number;
  elevationGainMeters: number;
}

interface GradeAdjustedPaceTableProps {
  data: GradeAdjustedPaceRow[];
  loading?: boolean;
}

function formatPace(minPerKm: number): string {
  const totalSeconds = Math.round(minPerKm * 60);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function GradeAdjustedPaceTable({ data, loading }: GradeAdjustedPaceTableProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[200px]">
        <span className="text-zinc-600 text-sm">Loading grade-adjusted pace data...</span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[100px]">
        <span className="text-zinc-600 text-sm">No hiking/walking activities found</span>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-xs font-medium text-zinc-500 mb-2">Grade-Adjusted Pace</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-xs text-zinc-400 uppercase tracking-wider">
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
                  className="border-b border-zinc-800/50 hover:bg-zinc-900/50"
                >
                  <td className="py-2 pr-4 text-zinc-300">
                    {new Date(row.date).toLocaleDateString()}
                  </td>
                  <td className="py-2 pr-4 text-zinc-300">{row.activityName}</td>
                  <td className="py-2 pr-4 tabular-nums">{row.distanceKm.toFixed(1)} km</td>
                  <td className="py-2 pr-4 tabular-nums">{row.durationMinutes.toFixed(0)} min</td>
                  <td className="py-2 pr-4 tabular-nums">
                    {formatPace(row.averagePaceMinPerKm)}/km
                  </td>
                  <td
                    className={`py-2 pr-4 tabular-nums ${highlightGap ? "text-amber-400 font-medium" : ""}`}
                  >
                    {formatPace(row.gradeAdjustedPaceMinPerKm)}/km
                  </td>
                  <td className="py-2 tabular-nums">{row.elevationGainMeters} m</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-zinc-700 mt-1">
        GAP highlighted in amber when it differs from actual pace by more than 15%.
      </p>
    </div>
  );
}
