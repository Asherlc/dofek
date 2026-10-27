import { z } from "zod";

export const climbingBoardSchema = z.strictObject({
  name: z.string().trim().min(1),
  externalId: z.string().trim().min(1).nullable(),
});

export const climbingWallAngleSchema = z
  .strictObject({
    value: z.number().finite(),
    unit: z.literal("degrees").nullable(),
  })
  .refine((angle) => angle.unit === null || (angle.value >= -90 && angle.value <= 90), {
    message: "A recorded degree angle must be between -90 and 90.",
  });

export type ClimbingBoard = z.infer<typeof climbingBoardSchema>;
export type ClimbingWallAngle = z.infer<typeof climbingWallAngleSchema>;
