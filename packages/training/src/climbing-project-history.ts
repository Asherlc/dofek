import { z } from "zod";
import { ropeMethodSchema } from "./climbing-log.ts";

const sessionCount = z.number().int().nonnegative();
const firstSend = z.strictObject({
  date: z.iso.date(),
  sessionCount: sessionCount.positive(),
  method: ropeMethodSchema.nullable(),
});

export const climbingProjectHistorySchema = z.strictObject({
  throughDate: z.iso.date(),
  sessionCount,
  unsuccessfulSessionCount: sessionCount,
  unknownSessionCount: sessionCount,
  firstSend: firstSend.nullable(),
  methodFirstSend: firstSend.extend({ method: ropeMethodSchema }).nullable(),
  repeatBeforeFirstSend: z.boolean(),
  earlierSessionsUnknown: z.boolean(),
  days: z
    .array(
      z.strictObject({
        date: z.iso.date(),
        outcome: z.enum(["send", "unsuccessful", "unknown"]),
        method: ropeMethodSchema.nullable(),
      }),
    )
    .readonly(),
});

export type ClimbingProjectHistory = z.infer<typeof climbingProjectHistorySchema>;

export interface ClimbingProjectHistoryState {
  data?: ClimbingProjectHistory | null;
  error?: { message: string } | null;
  isLoading?: boolean;
}
