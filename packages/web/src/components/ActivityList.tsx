import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface Activity {
  id: string;
  started_at: string;
  ended_at: string | null;
  activity_type: string;
  name: string | null;
  provider_id: string;
  source_providers: string[] | null;
}

interface ActivityListProps {
  activities: Activity[];
  loading?: boolean;
}

export function ActivityList({ activities, loading }: ActivityListProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={100} />;
  }

  if (activities.length === 0) {
    return <div className="text-zinc-500 text-sm py-4">No recent activities</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-left text-xs text-zinc-400 uppercase tracking-wider">
            <th scope="col" className="pb-2 pr-4 whitespace-nowrap">
              Date
            </th>
            <th scope="col" className="pb-2 pr-4 whitespace-nowrap">
              Type
            </th>
            <th scope="col" className="pb-2 pr-4 whitespace-nowrap">
              Name
            </th>
            <th scope="col" className="pb-2 pr-4 whitespace-nowrap">
              Duration
            </th>
            <th scope="col" className="pb-2 pr-4 whitespace-nowrap">
              Provider
            </th>
            <th scope="col" className="pb-2 whitespace-nowrap">
              Sources
            </th>
          </tr>
        </thead>
        <tbody>
          {activities.map((a) => {
            const duration =
              a.started_at && a.ended_at
                ? Math.round(
                    (new Date(a.ended_at).getTime() - new Date(a.started_at).getTime()) / 60000,
                  )
                : null;

            return (
              <tr key={a.id} className="border-b border-zinc-800/50 hover:bg-zinc-900/50">
                <td className="py-2 pr-4 text-zinc-300 whitespace-nowrap">
                  {new Date(a.started_at).toLocaleDateString()}
                </td>
                <td className="py-2 pr-4 capitalize whitespace-nowrap">{a.activity_type}</td>
                <td className="py-2 pr-4 text-zinc-300 max-w-[200px] truncate">{a.name ?? "—"}</td>
                <td className="py-2 pr-4 tabular-nums whitespace-nowrap">
                  {duration != null ? `${duration}m` : "—"}
                </td>
                <td className="py-2 pr-4 text-zinc-400 whitespace-nowrap">{a.provider_id}</td>
                <td className="py-2 text-zinc-500 text-xs whitespace-nowrap">
                  {a.source_providers?.join(", ")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
