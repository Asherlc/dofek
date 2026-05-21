import {
  formatDateForDisplay,
  formatDateYmd,
  formatDurationMinutes,
  formatTime,
  isToday,
  isYesterday,
  parseValidDate,
} from "@dofek/format/format";
import { formatActivityTypeLabel } from "@dofek/training/training";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageLayout } from "../components/PageLayout.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { trpc } from "../lib/trpc.ts";
import { useUnitConverter } from "../lib/unitContext.ts";

const WEEKS = 4;

export function ActivitiesPage() {
  const endDate = formatDateYmd();
  const query = trpc.calendar.weekList.useQuery({ weeks: WEEKS, endDate });
  const units = useUnitConverter();

  const dayGroups = query.data ?? [];

  return (
    <PageLayout title="Activities" subtitle="Last 4 weeks">
      {query.isLoading ? (
        <QueryStatePanel variant="loading" height={400} />
      ) : query.isError ? (
        <QueryStatePanel error={query.error} height={200} />
      ) : dayGroups.length === 0 ? (
        <QueryStatePanel
          variant="empty"
          message="No activities in the last 4 weeks."
          height={200}
        />
      ) : (
        <div className="space-y-6">
          {dayGroups.map((day) => (
            <section key={day.date}>
              <h3 className="text-xs font-medium text-muted uppercase tracking-wider mb-2">
                {formatDayHeader(day.date)}
              </h3>
              <div className="space-y-3">
                {day.activities.map((activity) => (
                  <Link
                    key={activity.id}
                    to="/activity/$id"
                    params={{ id: activity.id }}
                    className="card overflow-hidden block hover:bg-surface-elevated transition-colors"
                  >
                    <div className="p-3 sm:p-4 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <h4 className="text-sm font-semibold truncate">
                          {activity.name ?? formatActivityTypeLabel(activity.activityType)}
                        </h4>
                        <p className="text-xs text-muted mt-0.5">
                          {formatTime(activity.startedAt)} •{" "}
                          {formatDurationMinutes(activity.durationMin)} •{" "}
                          {formatActivityTypeLabel(activity.activityType)}
                        </p>
                      </div>
                    </div>

                    {activity.location ? (
                      <ActivityMapTile location={activity.location} units={units} />
                    ) : (
                      <div className="px-3 sm:px-4 pb-3 sm:pb-4 grid grid-cols-2 gap-2">
                        {activity.stats.map((stat) => (
                          <Stat key={stat.label} label={stat.label} value={stat.value} />
                        ))}
                      </div>
                    )}
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </PageLayout>
  );
}

interface ActivityMapTileProps {
  location: {
    tileUrl: string;
    distanceMeters: number | null;
    elevationGainM: number | null;
  };
  units: ReturnType<typeof useUnitConverter>;
}

function ActivityMapTile({ location, units }: ActivityMapTileProps) {
  const [loadFailed, setLoadFailed] = useState(false);

  return (
    <div className="relative h-40 bg-surface-secondary">
      {loadFailed ? (
        <div className="w-full h-full flex items-center justify-center text-xs text-muted">
          Map unavailable
        </div>
      ) : (
        <img
          src={location.tileUrl}
          alt="Activity location map"
          className="w-full h-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setLoadFailed(true)}
        />
      )}
      <div className="absolute bottom-2 left-2 flex gap-1">
        {location.distanceMeters != null ? (
          <span className="bg-black/60 text-white text-[11px] font-semibold px-2 py-0.5 rounded">
            {units.formatDistance(location.distanceMeters / 1000)}
          </span>
        ) : null}
        {location.elevationGainM != null ? (
          <span className="bg-black/60 text-white text-[11px] font-semibold px-2 py-0.5 rounded">
            ↑ {units.formatElevation(location.elevationGainM)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface-secondary rounded-md py-2 text-center">
      <div className="text-sm font-bold tabular-nums">{value}</div>
      <div className="text-[11px] text-muted mt-0.5">{label}</div>
    </div>
  );
}

function formatDayHeader(dateStr: string): string {
  const date = parseValidDate(`${dateStr}T00:00:00`);
  if (!date) return dateStr;
  if (isToday(date)) return "Today";
  if (isYesterday(date)) return "Yesterday";
  return formatDateForDisplay(date);
}
