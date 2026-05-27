import {
  formatDateForDisplay,
  formatDateYmd,
  formatDurationMinutes,
  formatTime,
  isToday,
  isYesterday,
  parseValidDate,
} from "@dofek/format/format";
import { formatMeasurementText } from "@dofek/format/units";
import { formatActivityTypeLabel } from "@dofek/training/training";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { PageLayout } from "../components/PageLayout.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { trpc } from "../lib/trpc.ts";
import { useUnitConverter } from "../lib/unitContext.ts";

const DEFAULT_WEEKS = 4;
const ALL_ACTIVITY_TYPES = "all";
const DATE_RANGE_OPTIONS = [
  { value: 4, label: "4 weeks" },
  { value: 8, label: "8 weeks" },
  { value: 12, label: "12 weeks" },
] as const;

export function ActivitiesPage() {
  const [weeks, setWeeks] = useState(DEFAULT_WEEKS);
  const [activityType, setActivityType] = useState(ALL_ACTIVITY_TYPES);
  const endDate = useMemo(() => formatDateYmd(), []);
  const units = useUnitConverter();
  const selectedActivityType = activityType === ALL_ACTIVITY_TYPES ? undefined : activityType;
  const queryInput = {
    weeks,
    endDate,
    ...(selectedActivityType ? { activityType: selectedActivityType } : {}),
  };
  const query = trpc.calendar.weekList.useQuery(queryInput);
  const overviewQuery = trpc.calendar.activityOverview.useQuery(queryInput);

  const dayGroups = query.data;

  const subtitle = `Last ${weeks} weeks`;

  return (
    <PageLayout title="Activities" subtitle={subtitle}>
      <div className="space-y-4">
        <ActivityControls
          activityTypes={overviewQuery.data?.activityTypes ?? []}
          activityType={activityType}
          weeks={weeks}
          onActivityTypeChange={setActivityType}
          onWeeksChange={setWeeks}
        />
        {overviewQuery.isError ? (
          <QueryStatePanel error={overviewQuery.error} height={120} />
        ) : (
          <ActivityOverview overview={overviewQuery.data} units={units} />
        )}
      </div>
      {query.isLoading ? (
        <QueryStatePanel variant="loading" height={400} />
      ) : query.isError ? (
        <QueryStatePanel error={query.error} height={200} />
      ) : !dayGroups || dayGroups.length === 0 ? (
        <QueryStatePanel
          variant="empty"
          message={`No activities in the last ${weeks} weeks.`}
          height={200}
        />
      ) : (
        <div className="space-y-7">
          {dayGroups.map((day) => (
            <section key={day.date}>
              <div className="mb-2 flex items-center gap-3">
                <h3 className="text-xs font-semibold text-muted uppercase tracking-wider">
                  {formatDayHeader(day.date)}
                </h3>
                <div className="h-px flex-1 bg-border/60" />
              </div>
              <div className="space-y-2">
                {day.activities.map((activity) => (
                  <Link
                    key={activity.id}
                    to="/activity/$id"
                    params={{ id: activity.id }}
                    className="card block overflow-hidden transition-colors hover:bg-surface-elevated"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-stretch">
                      <div className="flex min-w-0 flex-1 flex-col gap-3 p-3 sm:flex-row sm:items-center sm:p-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <h4 className="truncate text-sm font-semibold">
                              {activity.name ?? formatActivityTypeLabel(activity.activityType)}
                            </h4>
                            <span className="rounded border border-border bg-surface-secondary px-1.5 py-0.5 text-[11px] font-medium text-muted">
                              {formatActivityTypeLabel(activity.activityType)}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-muted">
                            {formatTime(activity.startedAt)} ·{" "}
                            {formatDurationMinutes(activity.durationMin)}
                          </p>
                        </div>
                        <ActivityMetricStrip activity={activity} units={units} />
                      </div>
                      {activity.location ? (
                        <ActivityMapTile location={activity.location} units={units} />
                      ) : null}
                    </div>
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

interface ActivityControlsProps {
  activityTypes: string[];
  activityType: string;
  weeks: number;
  onActivityTypeChange: (activityType: string) => void;
  onWeeksChange: (weeks: number) => void;
}

function ActivityControls({
  activityTypes,
  activityType,
  weeks,
  onActivityTypeChange,
  onWeeksChange,
}: ActivityControlsProps) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-solid p-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-semibold">Activity log</p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="flex items-center gap-2 text-xs text-muted">
          Date range
          <select
            value={weeks}
            onChange={(event) => onWeeksChange(Number(event.target.value))}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground"
          >
            {DATE_RANGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-muted">
          Activity type
          <select
            value={activityType}
            onChange={(event) => onActivityTypeChange(event.target.value)}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground"
          >
            <option value={ALL_ACTIVITY_TYPES}>All activities</option>
            {activityTypes.map((type) => (
              <option key={type} value={type}>
                {formatActivityTypeLabel(type)}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

interface ActivityOverviewData {
  activityCount: number;
  totalMinutes: number;
  totalDistanceMeters: number;
  totalElevationGainM: number;
}

function ActivityOverview({
  overview,
  units,
}: {
  overview: ActivityOverviewData | undefined;
  units: ReturnType<typeof useUnitConverter>;
}) {
  const items = [
    { label: "Activities", value: overview ? String(overview.activityCount) : "—" },
    {
      label: "Time",
      value: overview ? formatDurationMinutes(overview.totalMinutes) : "—",
    },
    {
      label: "Distance",
      value: overview
        ? formatMeasurementText(units.formatDistance(overview.totalDistanceMeters / 1000))
        : "—",
    },
    {
      label: "Elevation",
      value: overview
        ? formatMeasurementText(units.formatElevation(overview.totalElevationGainM))
        : "—",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="rounded-lg border border-border bg-surface-solid p-3">
          <div className="text-lg font-semibold tabular-nums">{item.value}</div>
          <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wider text-muted">
            {item.label}
          </div>
        </div>
      ))}
    </div>
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
    <div className="relative h-24 bg-surface-secondary sm:h-auto sm:w-36 sm:shrink-0">
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
      <div className="absolute bottom-2 left-2 flex flex-wrap gap-1">
        {location.distanceMeters != null ? (
          <span className="bg-black/60 text-white text-[11px] font-semibold px-2 py-0.5 rounded">
            {formatMeasurementText(units.formatDistance(location.distanceMeters / 1000))}
          </span>
        ) : null}
        {location.elevationGainM != null ? (
          <span className="bg-black/60 text-white text-[11px] font-semibold px-2 py-0.5 rounded">
            ↑ {formatMeasurementText(units.formatElevation(location.elevationGainM))}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ActivityMetricStrip({
  activity,
  units,
}: {
  activity: {
    location: {
      distanceMeters: number | null;
      elevationGainM: number | null;
    } | null;
    stats: { label: string; value: string }[];
  };
  units: ReturnType<typeof useUnitConverter>;
}) {
  const locationStats =
    activity.location != null
      ? [
          {
            label: "Distance",
            value:
              activity.location.distanceMeters != null
                ? formatMeasurementText(
                    units.formatDistance(activity.location.distanceMeters / 1000),
                  )
                : "—",
          },
          {
            label: "Elevation",
            value:
              activity.location.elevationGainM != null
                ? formatMeasurementText(units.formatElevation(activity.location.elevationGainM))
                : "—",
          },
        ]
      : activity.stats;

  return (
    <div className="grid grid-cols-2 gap-2 sm:w-72 sm:shrink-0">
      {locationStats.slice(0, 2).map((stat) => (
        <div key={stat.label} className="rounded-md bg-surface-secondary px-2 py-1.5 text-right">
          <div className="text-sm font-semibold tabular-nums">{stat.value}</div>
          <div className="mt-0.5 text-[11px] text-muted">{stat.label}</div>
        </div>
      ))}
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
