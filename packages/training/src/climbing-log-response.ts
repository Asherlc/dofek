import { z } from "zod";
import { numericWallAngleSchema } from "./climbing-experience.ts";
import type { ClimbingLogEntry } from "./climbing-log.ts";

export const climbingResponseVersionSchema = z.union([z.literal(1), z.literal(2)]).default(1);
export type ClimbingResponseVersion = z.infer<typeof climbingResponseVersionSchema>;

const holdTypeV1Schema = z.enum(["crimp", "sloper", "pinch", "pocket", "jug"]);
export const climbingLogTraitsV1Schema = z.strictObject({
  holdType: holdTypeV1Schema.nullable(),
  wallAngle: numericWallAngleSchema.nullable(),
});

/** Project only facts the original response can express, without guessing a predominant grip. */
export function toClimbingLogTraitsV1(
  traits: Pick<ClimbingLogEntry, "holdTypes" | "wallAngle">,
): z.infer<typeof climbingLogTraitsV1Schema> {
  const distinctHolds = [...new Set(traits.holdTypes)];
  const hold = distinctHolds.length === 1 ? holdTypeV1Schema.safeParse(distinctHolds[0]) : null;
  return {
    holdType: hold?.success ? hold.data : null,
    wallAngle: traits.wallAngle && "category" in traits.wallAngle ? null : traits.wallAngle,
  };
}
