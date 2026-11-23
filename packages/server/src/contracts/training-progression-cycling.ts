import { z } from "zod";

/** One explicitly recorded work interval and its mean directly measured power. */
export const cyclingProgressionIntervalSchema = z.object({
  index: z.number().int().positive(),
  workDurationSeconds: z.number().positive(),
  meanPowerWatts: z.number().positive(),
  powerCoveragePct: z.number().min(90).max(100),
  sourceProvider: z.string().nullable(),
  sourceActivityId: z.string().uuid().nullable(),
  sourceMemberActivityIds: z.array(z.string().uuid()),
});

/** A dated, user-owned ride used as evidence for the read-only cycling status. */
export const cyclingProgressionRideSchema = z.object({
  role: z.enum(["selected", "comparison"]),
  activityId: z.string().uuid(),
  date: z.iso.date(),
  sessionEffort: z.number().positive().max(5),
  modality: z.string(),
  exactWorkoutIdentities: z.array(z.object({ provider: z.string(), value: z.string() })),
  intervalCount: z.number().int().positive(),
  intervals: z.array(cyclingProgressionIntervalSchema),
  powerProvenance: z.object({
    measurementKind: z.literal("direct"),
    providers: z.array(z.string()),
    devices: z.array(z.string()),
  }),
});

/**
 * Server-authored readiness from two comparable recorded rides. Null means the
 * selected ride or its comparison history did not supply complete evidence.
 */
export const trainingProgressionCyclingSchema = z.nullable(
  z.object({
    status: z.literal("ready"),
    basis: z.enum(["exact_workout_identity", "recorded_work_protocol"]),
    comparison: z.object({
      intervalCount: z.number().int().positive(),
      largestDurationDifferencePct: z.number().nonnegative().max(5),
      largestMeanPowerDifferencePct: z.number().nonnegative().max(5),
    }),
    rides: z.tuple([cyclingProgressionRideSchema, cyclingProgressionRideSchema]),
  }),
);

export type CyclingProgressionInterval = z.infer<typeof cyclingProgressionIntervalSchema>;
export type CyclingProgressionRide = z.infer<typeof cyclingProgressionRideSchema>;
export type TrainingProgressionCycling = z.infer<typeof trainingProgressionCyclingSchema>;
