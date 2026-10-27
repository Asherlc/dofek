import { z } from "zod";

export const sportVolumeMetricSchema = z.enum(["time", "distance", "elevation", "work"]);
export type SportVolumeMetric = z.infer<typeof sportVolumeMetricSchema>;
const metricSchema = z.object({
  key: sportVolumeMetricSchema,
  label: z.string(),
  unit: z.enum(["min", "km", "m", "kJ"]),
});
export const sportVolumeResultSchema = z.object({
  sport: z.string().nullable(),
  sports: z.array(z.string()),
  metric: sportVolumeMetricSchema,
  metrics: z.array(metricSchema),
  unit: metricSchema.shape.unit,
  weeks: z.array(z.object({ week: z.iso.date(), value: z.number().nonnegative().nullable() })),
});
export type SportVolumeResult = z.infer<typeof sportVolumeResultSchema>;

export function sportVolumeMetrics(sport: string): z.infer<typeof metricSchema>[] {
  const metrics: z.infer<typeof metricSchema>[] = [{ key: "time", label: "Time", unit: "min" }];
  if (
    [
      "running",
      "cycling",
      "swimming",
      "walking",
      "hiking",
      "rowing",
      "skiing",
      "kayaking",
      "paddling",
      "skating",
    ].includes(sport)
  ) {
    metrics.push({
      key: "distance",
      label: sport === "cycling" ? "Outdoor distance" : "Distance",
      unit: "km",
    });
  }
  if (["running", "cycling", "walking", "hiking", "skiing"].includes(sport)) {
    metrics.push({ key: "elevation", label: "Elevation gain", unit: "m" });
  }
  if (sport === "cycling") metrics.push({ key: "work", label: "Mechanical work", unit: "kJ" });
  return metrics;
}
