import { z } from "zod";

export const healthMetricSchema = z.enum([
  "hrv",
  "resting_hr",
  "spo2",
  "respiratory_rate",
  "sleep_efficiency",
  "skin_temp",
  "steps",
  "distance_km",
  "exercise_minutes",
  "flights_climbed",
]);

export type HealthMetric = z.infer<typeof healthMetricSchema>;

export const healthMetricPresentation = {
  hrv: { label: "Heart rate variability", unit: "ms" },
  resting_hr: { label: "Resting heart rate", unit: "bpm" },
  spo2: { label: "Blood oxygen", unit: "%" },
  respiratory_rate: { label: "Respiratory rate", unit: "breaths/min" },
  sleep_efficiency: { label: "Sleep efficiency", unit: "%" },
  skin_temp: { label: "Skin temperature", unit: "°C" },
  steps: { label: "Steps", unit: "steps" },
  distance_km: { label: "Distance", unit: "km" },
  exercise_minutes: { label: "Exercise minutes", unit: "min" },
  flights_climbed: { label: "Flights climbed", unit: "flights" },
} satisfies Record<HealthMetric, { label: string; unit: string }>;

const dateSchema = z.iso.date();

function daysBetween(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

export const healthExplorerInputSchema = z
  .object({
    start_date: dateSchema,
    end_date: dateSchema,
    metrics: z.array(healthMetricSchema).min(1).max(4).default(["hrv", "resting_hr"]),
    granularity: z.enum(["daily", "weekly"]).default("daily"),
    timezone: z.string().min(1).optional(),
  })
  .superRefine((value, context) => {
    if (new Set(value.metrics).size !== value.metrics.length) {
      context.addIssue({
        code: "custom",
        message: "metrics must not contain duplicates",
        path: ["metrics"],
      });
    }
    if (value.start_date > value.end_date) {
      context.addIssue({
        code: "custom",
        message: "start_date must be on or before end_date",
        path: ["end_date"],
      });
      return;
    }
    if (daysBetween(value.start_date, value.end_date) > 366) {
      context.addIssue({
        code: "custom",
        message: "date range must not exceed 366 days",
        path: ["end_date"],
      });
    }
  });

export type HealthExplorerInput = z.infer<typeof healthExplorerInputSchema>;

const healthExplorerPointSchema = z.object({
  key: z.string().min(1),
  value: z.number().finite().nullable(),
});

const healthExplorerSeriesSchema = z.object({
  metric: healthMetricSchema,
  label: z.string().min(1),
  unit: z.string().min(1),
  points: z.array(healthExplorerPointSchema),
});

const healthExplorerSummarySchema = z.object({
  metric: healthMetricSchema,
  average: z.number().finite().nullable(),
  min: z.number().finite().nullable(),
  max: z.number().finite().nullable(),
});

export const healthExplorerSnapshotSchema = z.object({
  range: z.object({
    start_date: dateSchema,
    end_date: dateSchema,
    granularity: z.enum(["daily", "weekly"]),
  }),
  series: z.array(healthExplorerSeriesSchema),
  summary: z.array(healthExplorerSummarySchema),
  coverage: z.object({
    observed_days: z.number().int().nonnegative(),
    requested_days: z.number().int().positive(),
  }),
});

export type HealthExplorerSnapshot = z.infer<typeof healthExplorerSnapshotSchema>;
