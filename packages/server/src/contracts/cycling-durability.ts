/**
 * Wire contract for the `cycling.durability` comparison.
 *
 * The server owns selection and arithmetic; both clients render these values.
 * Selection inputs follow the approved field method (10 s / 1 min / 5 min /
 * 20 min efforts at 10–50 kJ/kg of prior work). The result keeps raw watts and
 * W/kg side by side so a client can lead with the presentation unit and still
 * disclose the recorded effort evidence.
 */
import { z } from "zod";

/** Effort durations preserved by the cycling durability read model. */
const cyclingDurabilityDurationSecondsSchema = z.union([
  z.literal(10),
  z.literal(60),
  z.literal(300),
  z.literal(1200),
]);

/** Nonzero accumulated-work thresholds, in kJ/kg, offered by the control. */
const cyclingDurabilityWorkKilojoulesPerKgSchema = z.union([
  z.literal(10),
  z.literal(20),
  z.literal(30),
  z.literal(40),
  z.literal(50),
]);

export const cyclingDurabilitySelectionSchema = z.object({
  durationSeconds: cyclingDurabilityDurationSecondsSchema,
  minimumWorkKilojoulesPerKg: cyclingDurabilityWorkKilojoulesPerKgSchema,
});
export type CyclingDurabilitySelection = z.infer<typeof cyclingDurabilitySelectionSchema>;

const cyclingDurabilityStatusSchema = z.enum([
  "available",
  "no_eligible_power_and_weight",
  "no_effort_after_work",
]);

/** `watts` when both winners share a weight, `w_per_kg` otherwise. */
const cyclingDurabilityPresentationUnitSchema = z.enum(["watts", "w_per_kg"]);
export type CyclingDurabilityPresentationUnit = z.infer<
  typeof cyclingDurabilityPresentationUnitSchema
>;

/** Only direct and positively-flagged meter power can qualify an effort. */
const cyclingDurabilityPowerProvenanceSchema = z.enum(["direct", "meter_flag"]);

const cyclingDurabilityWeightKindSchema = z.enum(["measured", "interpolated", "nearest"]);

const cyclingDurabilityWeightSourceSchema = z.object({
  date: z.string(),
  recorded_at: z.string(),
  value_kg: z.number(),
  provider: z.string(),
  source_record_id: z.string().nullable(),
  measurement_kind: z.literal("direct"),
});

/** The nearby-weight match attached to an effort, with dated source evidence. */
const cyclingDurabilityWeightEvidenceSchema = z.object({
  value_kg: z.number(),
  kind: cyclingDurabilityWeightKindSchema,
  method: z.enum(["same_day", "linear_interpolation", "nearest_within_30_days"]),
  quality: z.enum(["high", "medium", "low"]),
  distance_days: z.number(),
  sources: z.array(cyclingDurabilityWeightSourceSchema),
});

const cyclingDurabilityPowerEvidenceSchema = z.object({
  provenance: cyclingDurabilityPowerProvenanceSchema,
  sourceMemberId: z.string(),
  deviceId: z.string().nullable(),
  provider: z.string(),
  sourceExternalId: z.string().nullable(),
  measurementKind: z.string(),
});

const cyclingDurabilityCoverageEvidenceSchema = z.object({
  percent: z.number(),
  observedSamples: z.number().int(),
  medianSampleIntervalSeconds: z.number(),
  largestGapSeconds: z.number(),
});

/**
 * One winning effort. `date` is the ride's canonical local day and `startedAt`
 * its UTC timestamp. Work is the time integral of watts before the effort;
 * both the activity and source evidence are retained for the ride disclosure.
 */
const cyclingDurabilityEffortSchema = z.object({
  activityId: z.string(),
  activityName: z.string().nullable(),
  date: z.string(),
  startedAt: z.string(),
  elapsedStartSeconds: z.number(),
  elapsedEndSeconds: z.number(),
  watts: z.number(),
  wattsPerKg: z.number(),
  workKilojoules: z.number(),
  workKilojoulesPerKg: z.number(),
  power: cyclingDurabilityPowerEvidenceSchema,
  coverage: cyclingDurabilityCoverageEvidenceSchema,
  weight: cyclingDurabilityWeightEvidenceSchema,
});
export type CyclingDurabilityEffort = z.infer<typeof cyclingDurabilityEffortSchema>;

export const cyclingDurabilityResultSchema = z.object({
  status: cyclingDurabilityStatusSchema,
  range: z.object({
    /** Null for the All range; otherwise the inclusive finite-range start. */
    startDate: z.string().nullable(),
    endDate: z.string(),
  }),
  selection: cyclingDurabilitySelectionSchema,
  presentation: z.object({
    /** The unit the headline and `difference` use. */
    unit: cyclingDurabilityPresentationUnitSchema,
    /** Baseline minus after-work power in the presentation unit; positive means a drop. */
    difference: z.number(),
    /** Total kJ only when all eligible rides share the same matched weight. */
    absoluteWorkCutoffKilojoules: z.number().nullable(),
  }),
  baseline: cyclingDurabilityEffortSchema.nullable(),
  afterWork: cyclingDurabilityEffortSchema.nullable(),
  /** True when both values come from the same effort; disclosed by both clients. */
  sameEffort: z.boolean(),
});
export type CyclingDurabilityResult = z.infer<typeof cyclingDurabilityResultSchema>;
