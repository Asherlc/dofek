import {
  type ActivityMetric,
  activityDataStateLabel,
  formatActivityMetric,
  groupActivityMetrics,
} from "@dofek/format/activity-data-state";
import {
  formatDateLong,
  formatDurationMinutes,
  formatNumber,
  formatPace,
} from "@dofek/format/format";
import { formatRecordLocalTime, formatRecordLocalTimeRange } from "@dofek/format/record-local-time";
import type { UnitConverter } from "@dofek/format/units";
import { providerLabel } from "@dofek/providers/providers";
import { isIndoorCyclingModality } from "@dofek/training/endurance-types";
import { cadenceUnit, formatActivityTypeLabel, isCyclingActivity } from "@dofek/training/training";
import type { ComponentProps } from "react";
import type { ActivityPowerWork } from "../../../../../server/src/contracts/activity-metric-sources.ts";
import type { ActivityDetail } from "../../../../../server/src/models/activity.ts";
import { ActivityPhotos } from "../../../components/ActivityPhotos.tsx";
import { ActivitySourceDisclosure } from "../../../components/ActivitySourceDisclosure.tsx";

export function ActivityHeader({
  activity,
  powerWork,
  powerWorkSourceHint,
  trainingStressScore,
  units,
  photos,
  ...sourceDetails
}: {
  activity: ActivityDetail;
  powerWork?: ActivityPowerWork;
  powerWorkSourceHint?: string;
  trainingStressScore?: number | null;
  units: UnitConverter;
  photos?: Omit<ComponentProps<typeof ActivityPhotos>, "heading">;
} & Omit<ComponentProps<typeof ActivitySourceDisclosure>, "tree">) {
  const viewerTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localStartTime = formatRecordLocalTime(
    activity.startedAt,
    activity.localTimeContext,
    "start",
    undefined,
    viewerTimezone,
  );

  const avgPaceSecondsPerKm =
    activity.activityType === "running" ? activity.avgPaceSecondsPerKm : undefined;

  const stats: Array<
    ActivityMetric | { label: string; value: string; description?: string; attribution?: string }
  > = [];

  stats.push({
    label: "Duration",
    value:
      activity.durationMin === null ? "Unavailable" : formatDurationMinutes(activity.durationMin),
  });
  if (!(isCyclingActivity(activity.activityType) && isIndoorCyclingModality(activity.modality))) {
    stats.push(
      formatActivityMetric(
        "Distance",
        activity.totalDistance,
        activity.totalDistanceState,
        (distanceMeters) =>
          `${formatNumber(units.convertDistance(distanceMeters / 1000))} ${units.distanceLabel}`,
      ),
    );
  }
  stats.push(
    formatActivityMetric(
      "Elevation Gain",
      activity.elevationGain,
      activity.elevationGainState,
      (elevationMeters) =>
        `${Math.round(units.convertElevation(elevationMeters))} ${units.elevationLabel}`,
    ),
    formatActivityMetric(
      "Avg Heart Rate",
      activity.avgHr,
      activity.avgHrState,
      (value) => `${Math.round(value)} bpm`,
    ),
    formatActivityMetric(
      "Max Heart Rate",
      activity.maxHr,
      activity.maxHrState,
      (value) => `${Math.round(value)} bpm`,
    ),
    formatActivityMetric(
      "Avg Power",
      activity.avgPower,
      activity.avgPowerState,
      (value) => `${Math.round(value)} W`,
    ),
    formatActivityMetric(
      "Max Power",
      activity.maxPower,
      activity.maxPowerState,
      (value) => `${Math.round(value)} W`,
    ),
    ...(isCyclingActivity(activity.activityType) && powerWork?.workKilojoules != null
      ? [
          {
            label: "Energy Output",
            value: `${formatNumber(powerWork.workKilojoules, 0)} kJ`,
            description: powerWork.coverage.coveragePct < 99 ? "Partial power data" : undefined,
            attribution: powerWorkSourceHint,
          },
        ]
      : []),
    ...(isCyclingActivity(activity.activityType) && trainingStressScore != null
      ? [
          {
            label: "Training Stress Score",
            value: formatNumber(trainingStressScore, 1),
          },
        ]
      : []),
    avgPaceSecondsPerKm != null
      ? formatActivityMetric(
          "Avg Pace",
          activity.avgSpeed,
          activity.avgSpeedState,
          () => `${formatPace(units.convertPace(avgPaceSecondsPerKm))} ${units.paceLabel}`,
        )
      : formatActivityMetric(
          "Avg Speed",
          activity.avgSpeed,
          activity.avgSpeedState,
          (value) => `${formatNumber(units.convertSpeed(value * 3.6))} ${units.speedLabel}`,
        ),
  );

  // Running Form carries cadence with its coverage qualifier on the detail page.
  // Omit the duplicate header stat only when the form supplies that reading;
  // non-running and older/partial responses keep their existing Avg Cadence stat.
  if (activity.runningForm?.cadence == null) {
    stats.push(
      formatActivityMetric(
        "Avg Cadence",
        activity.avgCadence,
        activity.avgCadenceState,
        (value) => `${Math.round(value)} ${cadenceUnit(activity.activityType)}`,
      ),
    );
  }

  const heading = (
    <ActivitySourceDisclosure
      tree={activity.sourceTree}
      {...sourceDetails}
      heading={
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-1">
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-foreground">
              {activity.name ??
                formatActivityTypeLabel(activity.primaryActivityType ?? activity.activityType)}
            </h1>
            <span className="text-xs text-subtle">
              {formatActivityTypeLabel(activity.activityType)}
            </span>
          </div>
          <p className="text-sm text-subtle">
            {formatDateLong(activity.displayedDate, { timeZone: "UTC" })} at{" "}
            {localStartTime === "--" ? "Local time unavailable" : localStartTime}
          </p>
          {activity.climbingLogSessions.length > 0 ? (
            <ul aria-label="Logged climbs" className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {activity.climbingLogSessions.map((session) => {
                const window = formatRecordLocalTimeRange(
                  session.firstLoggedAt,
                  session.lastLoggedAt,
                  activity.localTimeContext,
                  undefined,
                  viewerTimezone,
                );
                const label = `${providerLabel(session.providerId)} · Logged climbs · ${window}`;
                return (
                  <li key={session.id} aria-label={label} className="text-xs text-subtle">
                    {label}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      }
    />
  );

  return (
    <div>
      {photos ? <ActivityPhotos {...photos} heading={heading} /> : heading}
      {activity.fitRecoveryWarning ? (
        <p
          className="mt-3 rounded border border-amber-400/50 bg-amber-400/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
          role="alert"
        >
          {activity.fitRecoveryWarning}
        </p>
      ) : null}

      {stats.length > 0 && (
        <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border/60 pt-4 sm:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] sm:gap-x-0">
          {groupActivityMetrics(stats).map(({ primary: primaryMetric, secondary }) => {
            const metric = "status" in primaryMetric ? primaryMetric : null;
            const unavailableMetric = metric?.status !== "available" ? metric : null;
            const displayedValue =
              "status" in primaryMetric
                ? primaryMetric.status === "available"
                  ? primaryMetric.value
                  : primaryMetric.reason
                : primaryMetric.value;
            return (
              <section
                key={primaryMetric.label}
                className="min-w-0 border-border/60 sm:border-l sm:px-6 sm:first:border-l-0 sm:first:pl-0"
                data-state={metric?.status}
                aria-label={
                  unavailableMetric
                    ? `${unavailableMetric.label} ${activityDataStateLabel(unavailableMetric.status)}: ${unavailableMetric.reason}`
                    : undefined
                }
              >
                <div className="text-xs text-subtle mb-0.5">
                  {unavailableMetric
                    ? `${unavailableMetric.label} ${activityDataStateLabel(unavailableMetric.status)}`
                    : primaryMetric.label}
                </div>
                <div
                  className={
                    unavailableMetric
                      ? "text-sm font-medium"
                      : "whitespace-nowrap text-2xl font-semibold tracking-tight tabular-nums"
                  }
                >
                  {displayedValue}
                </div>
                {secondary ? (
                  <div className="mt-1 text-xs text-subtle">
                    {"value" in secondary
                      ? `Max ${secondary.value}`
                      : `${secondary.label} ${activityDataStateLabel(secondary.status)}: ${secondary.reason}`}
                  </div>
                ) : null}
                {"description" in primaryMetric && primaryMetric.description ? (
                  <div className="text-xs text-subtle">{primaryMetric.description}</div>
                ) : null}
                {"attribution" in primaryMetric && primaryMetric.attribution ? (
                  <div role="status" className="text-xs text-subtle">
                    {primaryMetric.attribution}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
