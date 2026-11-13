import { z } from "zod";
import { trainingChartAvailabilitySchema } from "./training-chart-availability.ts";

export const runningResponseVersionSchema = z.union([z.literal(1), z.literal(2)]).default(1);

const runningDynamicsRowSchema = z.object({
  activityId: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  activityName: z.string(),
  cadence: z.number().nullable(),
  cadenceBasis: z.enum(["cadence_samples", "step_intervals", "unknown"]),
  cadenceObservedSeconds: z.number().nullable(),
  cadenceCoveragePercent: z.number().nullable(),
  strideLengthMeters: z.number().nullable(),
  stanceTimeMs: z.number().nullable(),
  verticalOscillationMm: z.number().nullable(),
  paceSecondsPerKm: z.number().nullable(),
  distanceKm: z.number().nullable(),
});
export type RunningDynamicsRow = z.infer<typeof runningDynamicsRowSchema>;

const runningDynamicsRowV1Schema = runningDynamicsRowSchema
  .omit({ cadenceBasis: true, cadenceObservedSeconds: true, cadenceCoveragePercent: true })
  .extend({ cadence: z.number(), paceSecondsPerKm: z.number(), distanceKm: z.number() })
  .strict();

export const runningDynamicsRowsResponseSchema = z.union([
  z.array(runningDynamicsRowSchema),
  z.array(runningDynamicsRowV1Schema),
]);

export const runningDynamicsResponseV2Schema = z.object({
  data: z.array(runningDynamicsRowSchema),
  availability: trainingChartAvailabilitySchema,
  cadenceAvailability: trainingChartAvailabilitySchema,
});
export type RunningDynamicsResponseV2 = z.infer<typeof runningDynamicsResponseV2Schema>;

const runningDynamicsResponseV1Schema = z
  .object({
    data: z.array(runningDynamicsRowV1Schema),
    availability: trainingChartAvailabilitySchema,
  })
  .strict();

export const runningDynamicsResponseSchema = z.union([
  runningDynamicsResponseV2Schema,
  runningDynamicsResponseV1Schema,
]);

export function toRunningDynamicsRowsV1(rows: readonly RunningDynamicsRow[]) {
  return rows.flatMap((row) => {
    if (
      typeof row.cadence !== "number" ||
      !Number.isFinite(row.cadence) ||
      typeof row.paceSecondsPerKm !== "number" ||
      !Number.isFinite(row.paceSecondsPerKm) ||
      typeof row.distanceKm !== "number" ||
      !Number.isFinite(row.distanceKm)
    )
      return [];
    return [
      runningDynamicsRowV1Schema.parse({
        activityId: row.activityId,
        date: row.date,
        activityName: row.activityName,
        cadence: row.cadence,
        paceSecondsPerKm: row.paceSecondsPerKm,
        distanceKm: row.distanceKm,
        strideLengthMeters: row.strideLengthMeters,
        stanceTimeMs: row.stanceTimeMs,
        verticalOscillationMm: row.verticalOscillationMm,
      }),
    ];
  });
}

export const RUNNING_DYNAMICS_INVALID_RESPONSE_MESSAGE =
  "Running data has an unexpected format. Refresh and try again. If it continues, contact support.";
