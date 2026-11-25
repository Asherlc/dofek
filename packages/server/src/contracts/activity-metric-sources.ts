import { activityMetricSourceSchema } from "@dofek/providers/activity-metric-source";
import { z } from "zod";
import { cyclingThresholdEvidenceSchema } from "./cycling-threshold.ts";

export const activityPowerZonesSchema = z
  .object({
    activityDate: z.iso.date(),
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
    /** Canonical ride-wide power TSS. Independent of selected zone power source. */
    trainingStressScore: z.number().nullable(),
    thresholdEvidence: cyclingThresholdEvidenceSchema,
  })
  .refine(
    (value) =>
      value.ftp === value.thresholdEvidence.value &&
      (value.ftp !== null || value.zones.length === 0),
    { message: "Power zones require matching configured threshold evidence" },
  )
  .nullable();

export const activityMetricSchema = z.enum([
  "heartRate",
  "power",
  "speed",
  "cadence",
  "altitude",
  "skinTemperature",
]);
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

export type SourceBindings = Readonly<
  Partial<
    Record<
      ActivityMetric,
      Readonly<{
        sourceId: string;
        label: string | null;
      }>
    >
  >
>;

export function offeredActivityMetricSources(
  selection: ActivityMetricSourceSelection | undefined,
  metrics: ActivityMetricSources | undefined,
): ActivityMetricSourceSelection {
  const sources: ActivityMetricSourceSelection = {};
  for (const metric of metrics ?? []) {
    const selected = selection?.[metric.key];
    sources[metric.key] = metric.sources.some((source) => source.id === selected)
      ? selected
      : metric.defaultSourceId;
  }
  return sources;
}

export function activityMetricSourceBindings(
  selection: ActivityMetricSourceSelection,
  metrics: ActivityMetricSources | undefined,
): SourceBindings {
  const result: Partial<Record<ActivityMetric, { sourceId: string; label: string | null }>> = {};
  for (const metric of metrics ?? []) {
    const sourceId = selection[metric.key];
    if (!sourceId) continue;
    result[metric.key] = {
      sourceId,
      label: metric.sources.find((source) => source.id === sourceId)?.label ?? null,
    };
  }
  return result;
}

export function formatActivityMetricSourceHint(
  previousInput: boolean,
  sources: SourceBindings | undefined,
  metric: ActivityMetric,
  requestedId: string | undefined,
  readingsDescription = "readings",
): string | undefined {
  if (!previousInput || sources?.[metric]?.sourceId === requestedId) return undefined;
  const label = sources?.[metric]?.label;
  return label
    ? `Showing previous ${readingsDescription} from ${label}`
    : `Showing previous ${readingsDescription}; source unavailable`;
}

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
  { key: "skinTemperature", channel: "skin_temperature", label: "Skin Temperature" },
] as const;
