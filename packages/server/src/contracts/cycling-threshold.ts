import { z } from "zod";

export const cyclingThresholdEvidenceSchema = z
  .object({
    value: z.number().positive().nullable(),
    unit: z.literal("watt"),
    method: z.literal("configured"),
    effective_from: z.string().nullable(),
    source_record_id: z.uuid().nullable(),
    unavailable_reason: z.string().nullable(),
  })
  .strict()
  .refine((value) => (value.value === null) === (value.unavailable_reason !== null), {
    message: "A configured threshold requires a value or an unavailable reason",
  });

export type CyclingThresholdEvidence = z.infer<typeof cyclingThresholdEvidenceSchema>;
