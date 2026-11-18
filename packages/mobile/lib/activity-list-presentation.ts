import {
  type ActivityDataState,
  type ActivityMetric,
  activityDataStateLabel,
  formatActivityMetric,
} from "@dofek/format/activity-data-state";
import { formatDurationMinutes } from "@dofek/format/format";
import {
  formatRecordLocalTime,
  type RecordLocalTimeContext,
} from "@dofek/format/record-local-time";
import { formatMeasurementText, type UnitConverter } from "@dofek/format/units";
import { providerSourceLabel } from "@dofek/providers/providers";
import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import { isIndoorCyclingModality } from "@dofek/training/endurance-types";
import { formatActivityTypeLabel } from "@dofek/training/training";
import type { ActivityLocation } from "dofek-server/types";

function sourceLocationLabel(location: ClimbingMapLocation): string {
  return `${location.scope === "area" ? "Area location" : "Climb location"}${location.name ? `: ${location.name}` : ""} · ${providerSourceLabel(location.providerId)}`;
}

export function displayRecordLocalTime(
  startedAt: string,
  localTimeContext: RecordLocalTimeContext,
): string {
  const localTime = formatRecordLocalTime(
    startedAt,
    localTimeContext,
    "start",
    undefined,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  return localTime === "--" ? "Local time unavailable" : localTime;
}

export function displayDuration(durationMin: number | null): string {
  return durationMin === null ? "Duration unavailable" : formatDurationMinutes(durationMin);
}

export function formatActivityAccessibilityLabel(
  action: "Open" | "Select" | "Deselect",
  activity: {
    activityType: string;
    primaryActivityType: string | null;
    modality: string | null;
    durationMin: number | null;
    localTimeContext: RecordLocalTimeContext;
    name: string | null;
    startedAt: string;
    distanceMeters: number | null;
    distanceState: ActivityDataState;
    elevationGainM: number | null;
    elevationState: ActivityDataState;
    location: ActivityLocation | null;
    stats: ActivityMetric[];
  },
  units: UnitConverter,
): string {
  const activityTypeLabel = formatActivityTypeLabel(
    activity.primaryActivityType ?? activity.activityType,
  );
  const labelParts = [
    activity.name ?? activityTypeLabel,
    displayRecordLocalTime(activity.startedAt, activity.localTimeContext),
    displayDuration(activity.durationMin),
  ];

  if (activity.name !== null && activity.name !== activityTypeLabel) {
    labelParts.push(activityTypeLabel);
  }

  const isIndoorCycling =
    activity.activityType === "cycling" && isIndoorCyclingModality(activity.modality);
  const hasRouteMetrics =
    !isIndoorCycling &&
    (activity.location?.kind === "recorded_gps" ||
      activity.distanceState.status !== "missing" ||
      activity.elevationState.status !== "missing");
  if (hasRouteMetrics) {
    const routeMetrics = [
      formatActivityMetric(
        "Distance",
        activity.distanceMeters,
        activity.distanceState,
        (distanceMeters) => formatMeasurementText(units.formatDistance(distanceMeters / 1000)),
      ),
      formatActivityMetric(
        "Elevation",
        activity.elevationGainM,
        activity.elevationState,
        (elevationMeters) => formatMeasurementText(units.formatElevation(elevationMeters)),
      ),
    ];
    for (const metric of routeMetrics) {
      if (metric.status === "available") {
        labelParts.push(`${metric.label} ${metric.value}`);
      } else {
        labelParts.push(
          `${metric.label} ${activityDataStateLabel(metric.status)}: ${metric.reason}`,
        );
      }
    }
  } else {
    for (const metric of activity.stats) {
      if (metric.status === "available") {
        labelParts.push(`${metric.label} ${metric.value}`);
      } else {
        labelParts.push(
          `${metric.label} ${activityDataStateLabel(metric.status)}: ${metric.reason}`,
        );
      }
    }
  }

  if (activity.location?.kind === "climbing_source") {
    labelParts.push(
      `Climbing source locations: ${activity.location.sourcePoints.map((point) => sourceLocationLabel(point.location)).join("; ")}`,
    );
  } else if (activity.location?.kind === "processing") {
    labelParts.push("Processing map");
  }

  return `${action} ${labelParts.join(", ")}`;
}
