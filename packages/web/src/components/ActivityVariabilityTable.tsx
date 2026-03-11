export interface ActivityVariabilityRow {
  date: string;
  activityName: string;
  normalizedPower: number;
  averagePower: number;
  variabilityIndex: number;
  intensityFactor: number;
}

export interface ActivityVariabilityTableProps {
  data: ActivityVariabilityRow[];
  loading?: boolean;
}

function getVariabilityColor(variabilityIndex: number): string {
  if (variabilityIndex < 1.05) return "text-green-400";
  if (variabilityIndex <= 1.1) return "text-yellow-400";
  return "text-red-400";
}

export function ActivityVariabilityTable({ data, loading }: ActivityVariabilityTableProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[200px]">
        <span className="text-zinc-600 text-sm">Loading variability data...</span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[100px]">
        <span className="text-zinc-600 text-sm">No activities with power data available</span>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800">
            <th className="text-left py-2 px-3 text-zinc-400 font-medium">Date</th>
            <th className="text-left py-2 px-3 text-zinc-400 font-medium">Activity</th>
            <th className="text-right py-2 px-3 text-zinc-400 font-medium">NP (W)</th>
            <th className="text-right py-2 px-3 text-zinc-400 font-medium">AP (W)</th>
            <th className="text-right py-2 px-3 text-zinc-400 font-medium">VI</th>
            <th className="text-right py-2 px-3 text-zinc-400 font-medium">IF</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr
              key={`${row.date}-${row.activityName}-${i}`}
              className="border-b border-zinc-900 hover:bg-zinc-900/50"
            >
              <td className="py-2 px-3 text-zinc-300">
                {new Date(row.date).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </td>
              <td className="py-2 px-3 text-zinc-300 max-w-[200px] truncate">{row.activityName}</td>
              <td className="py-2 px-3 text-right text-zinc-300">
                {row.normalizedPower.toFixed(1)}
              </td>
              <td className="py-2 px-3 text-right text-zinc-300">{row.averagePower.toFixed(1)}</td>
              <td
                className={`py-2 px-3 text-right font-mono ${getVariabilityColor(row.variabilityIndex)}`}
              >
                {row.variabilityIndex.toFixed(3)}
              </td>
              <td className="py-2 px-3 text-right text-zinc-300 font-mono">
                {row.intensityFactor.toFixed(3)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-zinc-600 mt-2">
        VI color: <span className="text-green-400">&lt;1.05 steady</span> /{" "}
        <span className="text-yellow-400">1.05-1.1 moderate</span> /{" "}
        <span className="text-red-400">&gt;1.1 variable</span>
      </p>
    </div>
  );
}
