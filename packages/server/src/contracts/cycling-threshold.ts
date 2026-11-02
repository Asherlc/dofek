import { z } from "zod";

export const cyclingThresholdUncertaintySchema = z
  .object({ kind: z.literal("not_quantifiable"), watts: z.null(), reason: z.string() })
  .strict();
export const cyclingThresholdUncertainty = cyclingThresholdUncertaintySchema.parse({
  kind: "not_quantifiable",
  watts: null,
  reason:
    "Reference-curve estimate; individual physiological FTP uncertainty has not been quantified.",
});

export const cyclingThresholdEvidenceSchema = z
  .object({
    value: z.number().positive().nullable(),
    unit: z.literal("watt"),
    method: z.literal("computed_eftp"),
    event_at: z.string().nullable(),
    evidence_activity_id: z.uuid().nullable(),
    evidence_at: z.string().nullable(),
    evidence_duration_seconds: z.number().positive().nullable(),
    evidence_power: z.number().nonnegative().nullable(),
    model_version: z.string().nullable(),
    unavailable_reason: z.string().nullable(),
    uncertainty: cyclingThresholdUncertaintySchema,
  })
  .strict();
export type CyclingThresholdEvidence = z.infer<typeof cyclingThresholdEvidenceSchema>;
export const cyclingThresholdHistoryItemSchema = cyclingThresholdEvidenceSchema
  .extend({
    activity_id: z.uuid().nullable(),
    evidence_kind: z.literal("computed"),
    historical_validity: z.literal("effective_dated"),
  })
  .strict();
export type CyclingThresholdHistoryItem = z.infer<typeof cyclingThresholdHistoryItemSchema>;
