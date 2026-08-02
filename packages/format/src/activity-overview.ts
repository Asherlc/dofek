import type { ActivityDataState } from "./activity-data-state.ts";

type FormatMeasuredValue = (value: number) => string;

export type ActivityOverviewChangeTrend = "higher" | "lower" | "unchanged" | "unavailable";

export interface ActivityOverviewChange {
  magnitude: number | null;
  trend: ActivityOverviewChangeTrend;
}

export interface ActivityOverviewMeasurementChange extends ActivityOverviewChange {
  state: ActivityDataState;
}

export interface ActivityOverviewComparison {
  periodLabel: string;
  activityCount: ActivityOverviewChange;
  totalMinutes: ActivityOverviewChange;
  totalDistanceMeters: ActivityOverviewMeasurementChange;
  totalElevationGainM: ActivityOverviewMeasurementChange;
}

function formatAvailableMeasurement(
  value: number | null,
  formatMeasured: FormatMeasuredValue,
  unavailableText: string,
): string {
  return value === null ? unavailableText : formatMeasured(value);
}

export function formatActivityOverviewDistance(
  distanceMeters: number | null,
  formatMeasured: FormatMeasuredValue,
): string {
  return formatAvailableMeasurement(distanceMeters, formatMeasured, "Distance not recorded");
}

export function formatActivityOverviewElevation(
  elevationMeters: number | null,
  formatMeasured: FormatMeasuredValue,
): string {
  return formatAvailableMeasurement(elevationMeters, formatMeasured, "Elevation unavailable");
}

export function formatActivityOverviewChange(
  change: ActivityOverviewChange | ActivityOverviewMeasurementChange,
  periodLabel: string,
  formatMagnitude: FormatMeasuredValue,
): string {
  if (change.trend === "unavailable" || change.magnitude === null) {
    if ("state" in change && change.state.status !== "available") {
      return `Comparison unavailable: ${change.state.reason}`;
    }
    return `Comparison unavailable vs ${periodLabel}`;
  }
  if (change.trend === "unchanged") return `No change vs ${periodLabel}`;

  const direction = change.trend === "higher" ? "more" : "less";
  return `${formatMagnitude(change.magnitude)} ${direction} vs ${periodLabel}`;
}

export function activityOverviewChangeForLabel(
  comparison: ActivityOverviewComparison,
  label: string,
): ActivityOverviewChange | ActivityOverviewMeasurementChange | undefined {
  if (label === "Activities") return comparison.activityCount;
  if (label === "Time") return comparison.totalMinutes;
  if (label === "Distance") return comparison.totalDistanceMeters;
  if (label === "Elevation") return comparison.totalElevationGainM;
  return undefined;
}
