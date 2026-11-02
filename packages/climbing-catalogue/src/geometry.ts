import { z } from "zod";

/** A complete source-recorded location in decimal degrees. */
export const gpsCoordinatesSchema = z.strictObject({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
});

export type GpsCoordinates = z.infer<typeof gpsCoordinatesSchema>;

export const numericWallAngleSchema = z
  .strictObject({
    value: z.number().finite(),
    unit: z.literal("degrees").nullable(),
  })
  .refine((angle) => angle.unit === null || (angle.value >= -90 && angle.value <= 90), {
    message: "A recorded degree angle must be between -90 and 90.",
  });
