import { z } from "zod";

const uint64 = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .refine((value) => BigInt(value) <= 18446744073709551615n);
export const sourcePlacementSchema = z
  .object({
    sourceId: z.uuid(),
    userId: z.uuid(),
    providerId: z.string().min(1),
    sourceVersion: uint64,
    generation: uint64,
    key: z.object({
      userId: z.uuid(),
      channel: z.string().min(1),
      recordedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/),
    }),
    activityId: z.uuid().nullable(),
    deleted: z.boolean(),
  })
  .refine(
    (placement) => placement.userId === placement.key.userId,
    "Placement key must belong to its source owner",
  );
