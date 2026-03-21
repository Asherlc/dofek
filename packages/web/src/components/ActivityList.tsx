import { parseValidDate } from "@dofek/format/format";
import { useNavigate } from "@tanstack/react-router";
import { formatNumber } from "../lib/format.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

export interface Activity {
  id: string;
  started_at: string;
  ended_at: string | null;
  activity_type: string;
  name: string | null;
  provider_id: string;
  source_providers: string[] | null;
  distance_meters?: number | null;
  calories?: number | null;
}

interface ActivityListProps {
  activities: Activity[];
  loading?: boolean;
  totalCount?: number;
  page?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
}

function formatActivityDate(startedAt: string): string {
  const startedDate = parseValidDate(startedAt);
  return startedDate ? startedDate.toLocaleDateString() : "—";
}

function formatActivityDuration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return "—";
  const startedDate = parseValidDate(startedAt);
  const endedDate = parseValidDate(endedAt);
  if (!startedDate || !endedDate) return "—";
  const durationMinutes = Math.round((endedDate.getTime() - startedDate.getTime()) / 60000);
  return durationMinutes >= 0 ? `${durationMinutes}m` : "—";
}

export function ActivityList({
  activities,
  loading,
  totalCount,
  page,
  pageSize,
  onPageChange,
}: ActivityListProps) {
  const navigate = useNavigate();
  const units = useUnitConverter();

  if (loading) {
    return <ChartLoadingSkeleton height={100} />;
  }

  if (activities.length === 0) {
    return <div className="text-zinc-500 text-sm py-4">No recent activities</div>;
  }

  const totalPages =
    totalCount != null && pageSize != null ? Math.ceil(totalCount / pageSize) : undefined;
  const currentPage = page ?? 0;

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
              Distance
            </th>
            <th scope="col" className="pb-2 pr-4 whitespace-nowrap">
              Calories
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
            return (
              <tr
                key={a.id}
                onClick={() => navigate({ to: "/activity/$id", params: { id: a.id } })}
                className="border-b border-zinc-800/50 hover:bg-zinc-900/50 cursor-pointer"
              >
                <td className="py-2 pr-4 text-zinc-300 whitespace-nowrap">
                  {formatActivityDate(a.started_at)}
                </td>
                <td className="py-2 pr-4 capitalize whitespace-nowrap">{a.activity_type}</td>
                <td className="py-2 pr-4 text-zinc-300 max-w-[200px] truncate">{a.name ?? "—"}</td>
                <td className="py-2 pr-4 tabular-nums whitespace-nowrap">
                  {formatActivityDuration(a.started_at, a.ended_at)}
                </td>
                <td className="py-2 pr-4 tabular-nums whitespace-nowrap text-zinc-300">
                  {a.distance_meters
                    ? `${formatNumber(units.convertDistance(a.distance_meters / 1000))} ${units.distanceLabel}`
                    : "—"}
                </td>
                <td className="py-2 pr-4 tabular-nums whitespace-nowrap text-zinc-300">
                  {a.calories ? `${Math.round(a.calories)} kcal` : "—"}
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

      {totalPages != null && totalPages > 1 && onPageChange && (
        <div className="flex items-center justify-between pt-3 border-t border-zinc-800/50 mt-2">
          <span className="text-xs text-zinc-500 tabular-nums">{totalCount} activities</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onPageChange(currentPage - 1)}
              disabled={currentPage <= 0}
              className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:text-zinc-700 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              Previous
            </button>
            <span className="text-xs text-zinc-500 tabular-nums">
              {currentPage + 1} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => onPageChange(currentPage + 1)}
              disabled={currentPage >= totalPages - 1}
              className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:text-zinc-700 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
