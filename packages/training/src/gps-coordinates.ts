import { z } from "zod";

/** A complete source-recorded location in decimal degrees. */
export const gpsCoordinatesSchema = z.strictObject({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
});

export type GpsCoordinates = z.infer<typeof gpsCoordinatesSchema>;
