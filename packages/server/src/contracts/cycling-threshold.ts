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

const cyclingThresholdEvidenceObject = z
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
const consistentAvailability = (value: {
  value: number | null;
  unavailable_reason: string | null;
}) => (value.value === null) === (value.unavailable_reason !== null);
export const cyclingThresholdEvidenceSchema = cyclingThresholdEvidenceObject.refine(
  consistentAvailability,
  { message: "A computed threshold requires a value or an unavailable reason" },
);
export type CyclingThresholdEvidence = z.infer<typeof cyclingThresholdEvidenceSchema>;
export const cyclingThresholdHistoryItemSchema = cyclingThresholdEvidenceObject
  .extend({
    activity_id: z.uuid().nullable(),
    evidence_kind: z.literal("computed"),
    historical_validity: z.literal("effective_dated"),
  })
  .strict()
  .refine(consistentAvailability, {
    message: "A computed threshold requires a value or an unavailable reason",
  });
export type CyclingThresholdHistoryItem = z.infer<typeof cyclingThresholdHistoryItemSchema>;

export const cyclingEftpTrendSchema = z.object({
  trend: z.array(
    z.object({
      date: z.string(),
      eftp: z.number().positive(),
      activityName: z.string().nullable(),
    }),
  ),
  currentEftp: z.number().positive().nullable(),
  currentEvidence: cyclingThresholdEvidenceSchema,
  model: z.null(),
});
