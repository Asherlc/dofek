import { z } from "zod";

const nullableNumber = z.number().nullable();
const nullableString = z.string().nullable();
const rangeSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  timezone: z.string(),
});
const coverageSchema = z
  .object({
    observed_samples: z.number().int().nonnegative(),
    covered_seconds: z.number().int().nonnegative(),
    missing_seconds: z.number().int().nonnegative(),
    zero_seconds: z.number().int().nonnegative(),
    coverage_pct: z.number().min(0).max(100),
    median_sample_interval_seconds: z.number().positive().nullable(),
    largest_gap_seconds: z.number().nonnegative().nullable(),
  })
  .strict();
const zonesSchema = z
  .object({
    threshold: z.number().positive(),
    upper_pcts: z.array(z.number().positive()),
    zones: z.array(
      z
        .object({
          zone: z.number().int().positive(),
          seconds: z.number().int().nonnegative(),
          percent: z.number().min(0).max(100),
        })
        .strict(),
    ),
  })
  .strict();
const thresholdSchema = z
  .object({
    value: z.number().positive(),
    unit: z.string().min(1),
    effective_from: z.string(),
    source_record_id: z.uuid(),
    kind: z.literal("configured"),
  })
  .strict();
const ftpThresholdSchema = thresholdSchema.extend({ value: z.number().positive().nullable() });
const intervalSchema = z
  .object({
    index: z.number().int(),
    type: z.enum(["work", "recovery", "warmup", "cooldown", "other"]),
    label: nullableString,
    source: z.enum(["recorded", "inferred"]),
    source_kind: z.enum(["provider_recorded", "inferred", "unknown"]),
    source_provider: nullableString,
    source_activity_id: z.uuid().nullable(),
    segment_type: nullableString,
    start_offset_seconds: z.number().int().nonnegative(),
    end_offset_seconds: z.number().int().nonnegative(),
    duration_seconds: z.number().int().nonnegative(),
    average_power_watts: nullableNumber,
    normalized_power_watts: nullableNumber,
    average_heart_rate_bpm: nullableNumber,
    average_cadence_rpm: nullableNumber,
    target_intensity: nullableNumber,
    target_zone: z.number().int().nullable(),
    target_cadence_rpm: nullableNumber,
    target_power_watts: nullableNumber,
    target_resistance: nullableNumber,
    work_recovery_kind: z.enum(["work", "recovery"]).nullable(),
    completion_pct: nullableNumber,
    source_member_activity_ids: z.array(z.uuid()),
    raw: z.unknown().nullable(),
    conflicts: z.array(z.string()).optional(),
    source_evidence: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .strict()
  .refine(
    ({ type, work_recovery_kind }) => work_recovery_kind === null || type === work_recovery_kind,
    { error: "work_recovery_kind must agree with type" },
  );
const bestPowerSchema = z
  .object({
    duration_seconds: z.number().int().positive(),
    watts: z.number().nonnegative(),
    start_offset_seconds: z.number().nonnegative().nullable(),
    power_kind: z.enum(["direct", "estimated", "unknown"]),
    quality: z
      .object({
        status: z.enum(["high", "moderate", "limited"]),
        reasons: z.array(z.string()),
        observed_samples: z.number().int().nonnegative().nullable(),
        coverage_pct: z.number().min(0).max(100).nullable(),
        median_sample_interval_seconds: z.number().positive().nullable(),
        largest_gap_seconds: z.number().nonnegative().nullable(),
      })
      .strict(),
  })
  .strict();

export const lambertsTestProtocol = "lamberts_submaximal_cycle_test" as const;

const lambertsStageSchema = z
  .object({
    stage: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    target_maximum_heart_rate_pct: z.union([z.literal(60), z.literal(80), z.literal(90)]),
    mean_power_watts: nullableNumber,
    mean_heart_rate_bpm: nullableNumber,
    mean_cadence_rpm: nullableNumber,
    mean_speed_meters_per_second: nullableNumber,
    perceived_exertion: z.null(),
  })
  .strict();

const lambertsRecoverySchema = z
  .object({
    observed_heart_rate_drop_bpm: nullableNumber,
    non_pedaling: z.boolean().nullable(),
    seated_upright: z.null(),
  })
  .strict();

const lambertsTestSchema = z
  .object({
    activity_id: z.uuid(),
    source_activity_id: z.uuid(),
    source_provider: z.string().min(1),
    source_name: nullableString,
    date: z.string(),
    started_at: z.string(),
    modality: nullableString,
    source_providers: z.array(z.string()),
    source_devices: z.array(z.string()),
    sample_source_providers: z.array(z.string()),
    power_measurement_kinds: z.array(z.enum(["direct", "estimated", "unknown"])),
    heart_rate_maximum: z
      .object({
        configured_bpm: nullableNumber,
        measurement_method: z.literal("unknown"),
      })
      .strict(),
    stages: z.array(lambertsStageSchema).length(3),
    recovery: lambertsRecoverySchema,
  })
  .strict();

const lambertsAnchorSchema = z
  .object({
    activity_id: z.uuid(),
    date: z.string(),
    started_at: z.string(),
    stage_2_mean_power_watts: nullableNumber,
    stage_3_mean_power_watts: nullableNumber,
  })
  .strict();

const lambertsTestComparisonSchema = z
  .object({
    earliest: lambertsAnchorSchema,
    latest: lambertsAnchorSchema,
    stage_2_mean_watts_change: nullableNumber,
    stage_3_mean_watts_change: nullableNumber,
  })
  .strict();

/** Strict MCP wire contract for the opt-in Lamberts comparison mode. */
export const lambertsTestResultSchema = z
  .object({
    protocol: z.literal(lambertsTestProtocol),
    range: rangeSchema,
    total_tests: z.number().int().nonnegative(),
    tests: z.array(lambertsTestSchema),
    next_cursor: nullableString,
    comparison: lambertsTestComparisonSchema.nullable(),
  })
  .strict();

/** Strict MCP wire contract for coverage-aware per-activity cycling metrics. */
export const cyclingTrainingMetricsOutputSchema = z
  .object({
    result: z
      .object({
        range: rangeSchema,
        requested_best_power_durations_seconds: z.array(z.number().int().positive()),
        definitions: z
          .object({
            normalized_power: z.string().min(1),
            variability_index: z.string().min(1),
            intensity_factor: z.string().min(1),
            training_stress_score: z.string().min(1),
            work_kilojoules: z.string().min(1),
            aerobic_efficiency: z.string().min(1),
            cardiac_drift: z.string().min(1),
            interval_detection: z.string().min(1),
          })
          .strict(),
        activities: z.array(
          z
            .object({
              activity_id: z.uuid(),
              date: z.string(),
              started_at: z.string(),
              ended_at: nullableString,
              duration_seconds: z.number().int().nonnegative(),
              name: nullableString,
              modality: nullableString,
              provider_id: z.string(),
              source_providers: z.array(z.string()),
              source_devices: z.array(z.string()),
              member_activity_ids: z.array(z.uuid()),
              thresholds: z
                .object({
                  ftp: ftpThresholdSchema.nullable(),
                  threshold_heart_rate: thresholdSchema.nullable(),
                })
                .strict(),
              metrics: z
                .object({
                  value_kind: z.literal("calculated_from_samples"),
                  power: z
                    .object({
                      average_watts: nullableNumber,
                      normalized_watts: nullableNumber,
                      variability_index: nullableNumber,
                      work_kilojoules: nullableNumber,
                      intensity_factor: nullableNumber,
                      training_stress_score: nullableNumber,
                    })
                    .strict(),
                  heart_rate: z
                    .object({ average_bpm: nullableNumber, maximum_bpm: nullableNumber })
                    .strict(),
                  cadence: z.object({ average_rpm: nullableNumber }).strict(),
                  aerobic_efficiency: z
                    .object({
                      power_to_heart_rate_ratio: nullableNumber,
                      paired_seconds: z.number().int().nonnegative(),
                    })
                    .strict(),
                  cardiac_drift: z
                    .object({
                      percent: nullableNumber,
                      first_half_power_to_heart_rate: nullableNumber,
                      second_half_power_to_heart_rate: nullableNumber,
                      paired_seconds: z.number().int().nonnegative(),
                      method: z.literal("equal_elapsed_time_halves_power_to_heart_rate"),
                    })
                    .strict(),
                  power_zones: zonesSchema.nullable(),
                  heart_rate_zones: zonesSchema.nullable(),
                  coverage: z
                    .object({
                      power: coverageSchema,
                      heart_rate: coverageSchema,
                      cadence: coverageSchema,
                    })
                    .strict(),
                  interval_source: z.enum(["recorded", "inferred", "none"]),
                  interval_detection: z
                    .object({
                      method: z.literal("30_second_average_above_105_percent_ftp"),
                      threshold_watts: z.number().positive(),
                      minimum_work_seconds: z.number().int().positive(),
                    })
                    .strict()
                    .nullable(),
                  intervals: z.array(intervalSchema),
                  unavailable_reasons: z.array(
                    z.object({ metric: z.string().min(1), reason: z.string().min(1) }).strict(),
                  ),
                })
                .strict(),
              best_powers: z.array(bestPowerSchema),
              provider_aggregates: z
                .object({
                  average_power_watts: nullableNumber,
                  average_heart_rate_bpm: nullableNumber,
                  maximum_heart_rate_bpm: nullableNumber,
                  kind: z.literal("calculated_read_model"),
                })
                .strict(),
              provenance: z
                .object({
                  duplicate_merged: z.boolean(),
                  sample_source_providers: z.array(z.string()),
                  power_measurement_kinds: z.array(z.enum(["direct", "estimated", "unknown"])),
                  activity_timezone: nullableString,
                  timezone_source: z.string().min(1),
                  timezone_assumption_required: z.boolean(),
                })
                .strict(),
              quality: z
                .object({
                  status: z.enum(["high", "moderate", "limited"]),
                  trustworthy_for_longitudinal_comparison: z.boolean(),
                  reasons: z.array(z.string()),
                })
                .strict(),
            })
            .strict(),
        ),
        next_cursor: nullableString,
      })
      .strict(),
  })
  .strict();

/** Registered responses for cycling analysis. */
export const cyclingTrainingMetricsToolOutputSchema = cyclingTrainingMetricsOutputSchema.extend({
  result: z.union([cyclingTrainingMetricsOutputSchema.shape.result, lambertsTestResultSchema]),
});
