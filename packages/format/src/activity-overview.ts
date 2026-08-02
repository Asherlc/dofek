import { z } from "zod";
import { activityDataStateSchema } from "./activity-data-state.ts";
import { formatDurationMinutes } from "./format.ts";
import { formatMeasurementText, type UnitConverter } from "./units.ts";

type FormatMeasuredValue = (value: number) => string;

export const activityOverviewTrendSchema = z.enum(["higher", "lower", "unchanged", "unavailable"]);

export const activityOverviewChangeSchema = z.object({
  magnitude: z.number().nonnegative().nullable(),
  trend: activityOverviewTrendSchema,
});

export const activityOverviewMeasurementChangeSchema = activityOverviewChangeSchema.extend({
  state: activityDataStateSchema,
});

export const activityOverviewComparisonSchema = z.object({
  periodLabel: z.string().trim().min(1),
  activityCount: activityOverviewChangeSchema,
  totalMinutes: activityOverviewChangeSchema,
  totalDistanceMeters: activityOverviewMeasurementChangeSchema,
  totalElevationGainM: activityOverviewMeasurementChangeSchema,
});

export type ActivityOverviewChangeTrend = z.infer<typeof activityOverviewTrendSchema>;

export type ActivityOverviewChange = z.infer<typeof activityOverviewChangeSchema>;

export type ActivityOverviewMeasurementChange = z.infer<
  typeof activityOverviewMeasurementChangeSchema
>;

export type ActivityOverviewComparison = z.infer<typeof activityOverviewComparisonSchema>;

export type ActivityOverviewKey =
  | "activityCount"
  | "totalMinutes"
  | "totalDistanceMeters"
  | "totalElevationGainM";

export function createActivityOverviewComparisonFormatters(
  units: Pick<UnitConverter, "formatDistance" | "formatElevation">,
): Record<ActivityOverviewKey, (value: number) => string> {
  return {
    activityCount: (value) => String(value),
    totalMinutes: (value) => formatDurationMinutes(value),
    totalDistanceMeters: (value) => formatMeasurementText(units.formatDistance(value / 1000)),
    totalElevationGainM: (value) => formatMeasurementText(units.formatElevation(value)),
  };
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

export function activityOverviewChangeForKey(
  comparison: ActivityOverviewComparison,
  key: ActivityOverviewKey,
): ActivityOverviewComparison[ActivityOverviewKey] {
  return comparison[key];
}
