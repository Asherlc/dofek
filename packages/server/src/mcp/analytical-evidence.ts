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

export type SourceReference = z.infer<typeof sourceReferenceSchema>;
