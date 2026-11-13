import { z } from "zod";

/** Maximum complete format-1 frame: eight header bytes plus a u16-sized body. */
export const WHOOP_SENSOR_FRAME_BYTES = 65_543;
export const WHOOP_SENSOR_BATCH_BYTES = 262_144;
export const SENSOR_RECORD_CHANNEL = "sensor_record";

export const whoopDeviceInfoSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    model: z.string().min(1).max(200).optional(),
    firmware: z.string().min(1).max(200).optional(),
    hardware: z.string().min(1).max(200).optional(),
    serial: z.string().min(1).max(200).optional(),
  })
  .strict();

export const whoopSensorRecordSchema = z
  .object({
    captureId: z.uuid(),
    timestamp: z.iso.datetime({ offset: true }),
    frameHex: z
      .string()
      .min(24)
      .max(WHOOP_SENSOR_FRAME_BYTES * 2)
      .regex(/^(?:[0-9a-f]{2})+$/),
    deviceInfo: whoopDeviceInfoSchema,
  })
  .strict();

export type WhoopSensorRecord = z.infer<typeof whoopSensorRecordSchema>;

export const whoopSensorReadingSchema = z.object({
  captureId: z.uuid(),
  receivedAt: z.iso.datetime({ offset: true }),
  measuredAt: z.iso.datetime({ offset: true }).nullable(),
  packetType: z.number().int(),
  layout: z.number().int(),
  skinTemperatureC: z.number().nullable(),
  interpretation: z.string(),
  fields: z.array(z.object({ label: z.string(), value: z.number(), unit: z.string() })),
  rawFrameHex: z.string(),
  deviceInfo: whoopDeviceInfoSchema,
});
export type WhoopSensorReading = z.infer<typeof whoopSensorReadingSchema>;

export const whoopSensorSnapshotSchema = z.object({
  latestReceivedAt: z.string().nullable(),
  latestMeasuredAt: z.string().nullable(),
  skinTemperatureC: z.number().nullable(),
  records: z.array(whoopSensorReadingSchema.extend({ deviceId: z.string() })),
});
export type WhoopSensorSnapshot = z.infer<typeof whoopSensorSnapshotSchema>;
