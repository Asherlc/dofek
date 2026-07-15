import { formatDurationMinutes, formatTime } from "@dofek/format/format";
import { formatMeasurementText, type UnitConverter } from "@dofek/format/units";
import {
  formatProviderAbsentTombstoneSummary,
  formatProviderPartialAbsenceSummary,
  type ProviderAbsentSource,
} from "@dofek/providers/providers";
import { formatActivityTypeLabel } from "@dofek/training/training";
import { type ActivityMapLocation, ActivityMapTile } from "./ActivityMapTile.tsx";
import { ActivityTypeIcon } from "./ActivityTypeIcon.tsx";

export interface ActivityCardData {
  id: string;
  name: string | null;
  activityType: string;
  startedAt: string;
  durationMin: number;
  isProviderAbsent?: boolean;
  providerId?: string;
  providerAbsentAt?: string | null;
  partialAbsentSources?: ProviderAbsentSource[];
  location: ActivityMapLocation | null;
  stats: { label: string; value: string }[];
}

interface ActivityCardContentProps {
  activity: ActivityCardData;
  units: UnitConverter;
  selectMode: boolean;
  selected: boolean;
}

export function ActivityCardContent({
  activity,
  units,
  selectMode,
  selected,
}: ActivityCardContentProps) {
  const isHidden = activity.isProviderAbsent === true;
  const tombstoneSummary =
    isHidden && activity.providerId && activity.providerAbsentAt
      ? formatProviderAbsentTombstoneSummary(activity.providerId, activity.providerAbsentAt)
      : null;
  const partialAbsenceSummary = formatProviderPartialAbsenceSummary(
    activity.partialAbsentSources ?? [],
  );
  const activityLabel = formatActivityTypeLabel(activity.activityType);

  return (
    <div
      data-testid="activity-card-layout"
      className="grid min-h-60 sm:grid-cols-[minmax(0,2fr)_minmax(18rem,3fr)]"
    >
      <div className="flex min-w-0 flex-col p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {selectMode ? (
            <input
              type="checkbox"
              aria-label={`Select ${activity.name ?? activityLabel}`}
              checked={selected}
              readOnly
              className="h-4 w-4 cursor-pointer accent-accent"
            />
          ) : null}
          <ActivityTypeIcon activityType={activity.activityType} variant="plain" />
          <div className="min-w-0">
            <h4 className="truncate text-base font-semibold">{activity.name ?? activityLabel}</h4>
            <p className="mt-0.5 text-xs text-muted">
              {formatTime(activity.startedAt)} · {formatDurationMinutes(activity.durationMin)}
            </p>
          </div>
        </div>
        {isHidden ? (
          <span className="mt-3 w-fit rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
            Removed
          </span>
        ) : null}
        {tombstoneSummary ? (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{tombstoneSummary}</p>
        ) : null}
        {partialAbsenceSummary ? (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{partialAbsenceSummary}</p>
        ) : null}
        <div data-testid="activity-detail-metrics" className="mt-auto pt-6">
          <ActivityMetricGrid activity={activity} units={units} />
        </div>
      </div>
      <div
        data-testid="activity-secondary-panel"
        className="flex min-h-64 flex-col border-t border-border/60 bg-surface-secondary/45 p-4 sm:border-l sm:border-t-0"
      >
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Route</p>
        <div
          data-testid="activity-secondary-inset"
          className="mt-3 min-h-48 flex-1 overflow-hidden rounded-lg border border-border bg-surface-solid"
        >
          {activity.location ? (
            <ActivityMapTile location={activity.location} variant="panel" />
          ) : (
            <div className="flex h-full min-h-48 items-center justify-center text-sm text-muted">
              No route recorded
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ActivityMetricGrid({
  activity,
  units,
}: {
  activity: Pick<ActivityCardData, "location" | "stats">;
  units: UnitConverter;
}) {
  const metrics = activity.location
    ? [
        {
          label: "Distance",
          value:
            activity.location.distanceMeters != null
              ? formatMeasurementText(units.formatDistance(activity.location.distanceMeters / 1000))
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
    <div className="grid grid-cols-2 gap-x-5 gap-y-4">
      {metrics.slice(0, 2).map((metric) => (
        <div key={metric.label} className="min-w-0">
          <div className="text-lg font-semibold tabular-nums">{metric.value}</div>
          <div className="mt-1 text-[11px] leading-tight text-muted">{metric.label}</div>
        </div>
      ))}
    </div>
  );
}
