import { z } from "zod";

export const healthStatusMetricSchema = z.object({
  metric: z.enum([
    "hrv",
    "resting_heart_rate",
    "respiratory_rate",
    "sleep_efficiency",
    "spo2",
    "steps",
    "skin_temperature",
    "trend_weight",
    "body_fat_percentage",
  ]),
  label: z.string(),
  value: z.number().nullable(),
  baseline: z.number().nullable(),
  sampleDeviation: z.number().nullable(),
  deviation: z.number().nullable(),
  direction: z.enum(["above", "below", "aligned", "unknown"]),
  intent: z.enum(["higher", "lower", "maintain", "neutral"]),
  statusToken: z.enum([
    "insufficient_data",
    "near_baseline",
    "moving_as_intended",
    "notable_deviation",
    "far_from_baseline",
  ]),
  statusColor: z.enum(["positive", "warning", "danger", "muted"]),
  statusLabel: z.string(),
  evaluationRule: z.string(),
  explanation: z.string(),
});

export type HealthStatusMetric = z.infer<typeof healthStatusMetricSchema>;
export type HealthMetricKey = HealthStatusMetric["metric"];
