import { z } from "zod";

export const epistemicKindSchema = z.enum([
  "measured",
  "provider_recorded",
  "aggregated",
  "calculated",
  "estimated",
  "interpolated",
  "inferred",
  "unknown",
]);

export const measurementKindSchema = z.enum(["direct", "estimated", "unknown"]);

export const sourceReferenceSchema = z.object({
  provider_id: z.string().min(1),
  device_id: z.string().min(1).nullable(),
  source_type: z.string().min(1).nullable(),
  source_record_id: z.string().min(1).nullable(),
  activity_id: z.string().uuid().nullable(),
  member_activity_id: z.string().uuid().nullable(),
  measurement_kind: measurementKindSchema,
});

const optionalCountSchema = z.number().int().nonnegative().nullable().optional();
const optionalSecondsSchema = z.number().finite().nonnegative().nullable().optional();

export const qualityEvidenceSchema = z.object({
  status: z.enum(["high", "moderate", "limited", "unavailable"]),
  reasons: z.array(z.string().min(1)),
  observed_samples: optionalCountSchema,
  expected_samples: optionalCountSchema,
  coverage_pct: z.number().finite().min(0).max(100).nullable().optional(),
  largest_gap_seconds: optionalSecondsSchema,
  timezone_assumption: z.string().min(1).nullable().optional(),
});

const calculationParameterSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const calculationEvidenceSchema = z.object({
  kind: epistemicKindSchema,
  method: z.string().min(1),
  formula: z.string().min(1).nullable(),
  parameters: z.record(z.string(), calculationParameterSchema),
  assumptions: z.array(z.string().min(1)),
});

export const unavailableMetricSchema = z.object({
  value: z.null(),
  reason: z.string().min(1),
});

export type SourceReference = z.infer<typeof sourceReferenceSchema>;
