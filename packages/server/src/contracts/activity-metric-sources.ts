import { activityMetricSourceSchema } from "@dofek/providers/activity-metric-source";
import { z } from "zod";
import { cyclingThresholdEvidenceSchema } from "./cycling-threshold.ts";

export const activityPowerZonesSchema = z
  .object({
    zones: z.array(
      z.object({
        zone: z.number().int().min(1).max(7),
        label: z.string(),
        minPct: z.number().nonnegative(),
        maxPct: z.number().nullable(),
        seconds: z.number().nonnegative(),
        percent: z.number().min(0).max(100),
      }),
    ),
    ftp: z.number().positive().nullable(),
    thresholdEvidence: cyclingThresholdEvidenceSchema,
  })
  .nullable();

export const activityMetricSchema = z.enum(["heartRate", "power", "speed", "cadence", "altitude"]);
export type ActivityMetric = z.infer<typeof activityMetricSchema>;
export const activityMetricSourceSelectionSchema = z.partialRecord(
  activityMetricSchema,
  z.string().min(1).max(4096),
);
export type ActivityMetricSourceSelection = z.infer<typeof activityMetricSourceSelectionSchema>;
export const activityMetricSourcesSchema = z.array(
  z.object({
    key: activityMetricSchema,
    label: z.string(),
    sources: z.array(activityMetricSourceSchema).nonempty(),
    defaultSourceId: z.string(),
  }),
);
export type ActivityMetricSources = z.infer<typeof activityMetricSourcesSchema>;

export const activityHeartRateContextSchema = z.object({
  window: z.object({ startedAt: z.iso.datetime(), endedAt: z.iso.datetime().nullable() }),
  points: z.array(z.object({ recordedAt: z.iso.datetime(), value: z.number().nullable() })),
});
export type ActivityHeartRateContext = z.infer<typeof activityHeartRateContextSchema>;

export const activityPowerWorkSchema = z.object({
  workKilojoules: z.number().nonnegative().nullable(),
  coverage: z.object({
    coveredSeconds: z.number().int().nonnegative(),
    coveragePct: z.number().min(0).max(100),
  }),
});
export type ActivityPowerWork = z.infer<typeof activityPowerWorkSchema>;

export const ACTIVITY_CHART_METRICS = [
  { key: "heartRate", channel: "heart_rate", label: "Heart Rate" },
  { key: "power", channel: "power", label: "Power" },
  { key: "speed", channel: "speed", label: "Speed" },
  { key: "cadence", channel: "cadence", label: "Cadence" },
  { key: "altitude", channel: "altitude", label: "Elevation" },
] as const;
