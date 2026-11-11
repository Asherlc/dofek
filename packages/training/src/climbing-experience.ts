import { numericWallAngleSchema } from "@dofek/climbing-catalogue/geometry";
import { z } from "zod";

export { numericWallAngleSchema };

export const climbingBoardSchema = z.strictObject({
  name: z.string().trim().min(1),
  externalId: z.string().trim().min(1).nullable(),
});

export const climbingWallAngleSchema = z.union([
  numericWallAngleSchema,
  z.strictObject({ category: z.enum(["slab", "vertical", "overhang", "roof"]) }),
]);

export type ClimbingBoard = z.infer<typeof climbingBoardSchema>;
export type ClimbingWallAngle = z.infer<typeof climbingWallAngleSchema>;
