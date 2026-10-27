import { activityMetricSourceSchema } from "@dofek/providers/activity-metric-source";
import { z } from "zod";

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

export const ACTIVITY_CHART_METRICS = [
  { key: "heartRate", channel: "heart_rate", label: "Heart Rate" },
  { key: "power", channel: "power", label: "Power" },
  { key: "speed", channel: "speed", label: "Speed" },
  { key: "cadence", channel: "cadence", label: "Cadence" },
  { key: "altitude", channel: "altitude", label: "Elevation" },
] as const;
