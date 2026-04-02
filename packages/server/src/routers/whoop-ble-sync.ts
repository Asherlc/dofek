import { sql } from "drizzle-orm";
import { z } from "zod";
import { logger } from "../logger.ts";
import { protectedProcedure, router } from "../trpc.ts";

const PROVIDER_ID = "whoop_ble";
const INSERT_BATCH_SIZE = 2000;

// ── Zod schemas ──

const realtimeDataSampleSchema = z.object({
  timestamp: z.string(), // ISO 8601 with millisecond precision
  heartRate: z.number().int().min(0).max(255),
  /** R-R interval in milliseconds (beat-to-beat timing from PPG). 0 when unavailable. */
  rrIntervalMs: z.number().int().min(0).max(32767).default(0),
  quaternionW: z.number(),
  quaternionX: z.number(),
  quaternionY: z.number(),
  quaternionZ: z.number(),
  /** Raw optical/PPG bytes from payload offsets 23-40, hex-encoded (36 chars = 18 bytes) */
  opticalRawHex: z
    .string()
    .regex(/^[0-9a-f]{36}$/)
    .default("0".repeat(36)),
});

const pushRealtimeDataInput = z.object({
  deviceId: z.string().min(1),
  samples: z.array(realtimeDataSampleSchema),
});

export type WhoopBleRealtimeDataSample = z.infer<typeof realtimeDataSampleSchema>;

type Database = Parameters<Parameters<typeof protectedProcedure.mutation>[0]>[0]["ctx"]["db"];

/** Ensure the whoop_ble provider row exists */
async function ensureProvider(database: Database, userId: string) {
  await database.execute(
    sql`INSERT INTO fitness.provider (id, name, user_id)
        VALUES (${PROVIDER_ID}, 'WHOOP BLE', ${userId})
        ON CONFLICT (id) DO NOTHING`,
  );
}

/** Insert WHOOP BLE realtime samples into sensor_sample. */
async function insertRealtimeDataBatch(
  database: Database,
  userId: string,
  deviceId: string,
  samples: WhoopBleRealtimeDataSample[],
): Promise<number> {
  if (samples.length === 0) return 0;

  let totalInserted = 0;

  for (let offset = 0; offset < samples.length; offset += INSERT_BATCH_SIZE) {
    const batch = samples.slice(offset, offset + INSERT_BATCH_SIZE);

    // Insert HR samples (only for samples with a valid reading).
    const heartRateSamples = batch.filter((sample) => sample.heartRate > 0);
    if (heartRateSamples.length > 0) {
      const hrSensorValues = heartRateSamples.map(
        (sample) =>
          sql`(${sample.timestamp}::timestamptz, ${userId}::uuid, ${PROVIDER_ID}, ${deviceId}, ${"ble"}, ${"heart_rate"}, ${sample.heartRate}::real)`,
      );

      await database.execute(
        sql`INSERT INTO fitness.sensor_sample
            (recorded_at, user_id, provider_id, device_id, source_type, channel, scalar)
            VALUES ${sql.join(hrSensorValues, sql`, `)}`,
      );

      const rrSamples = heartRateSamples.filter((sample) => sample.rrIntervalMs > 0);
      if (rrSamples.length > 0) {
        const rrValues = rrSamples.map(
          (sample) =>
            sql`(${sample.timestamp}::timestamptz, ${userId}::uuid, ${PROVIDER_ID}, ${deviceId}, ${"ble"}, ${"rr_interval_ms"}, ${sample.rrIntervalMs}::real)`,
        );
        await database.execute(
          sql`INSERT INTO fitness.sensor_sample
              (recorded_at, user_id, provider_id, device_id, source_type, channel, scalar)
              VALUES ${sql.join(rrValues, sql`, `)}`,
        );
      }
    }

    // Insert quaternion only when it is present (compact 0x28 packets omit it and report all zeros).
    const orientationSamples = batch.filter(
      (sample) =>
        sample.quaternionW !== 0 ||
        sample.quaternionX !== 0 ||
        sample.quaternionY !== 0 ||
        sample.quaternionZ !== 0,
    );
    if (orientationSamples.length > 0) {
      const orientationSensorValues = orientationSamples.map(
        (sample) =>
          sql`(${sample.timestamp}::timestamptz, ${userId}::uuid, ${PROVIDER_ID}, ${deviceId}, ${"ble"}, ${"orientation"}, ARRAY[${sample.quaternionW}, ${sample.quaternionX}, ${sample.quaternionY}, ${sample.quaternionZ}]::real[])`,
      );
      await database.execute(
        sql`INSERT INTO fitness.sensor_sample
            (recorded_at, user_id, provider_id, device_id, source_type, channel, vector)
            VALUES ${sql.join(orientationSensorValues, sql`, `)}`,
      );
    }

    totalInserted += batch.length;
  }

  return totalInserted;
}

// ── Router ──

export const whoopBleSyncRouter = router({
  pushRealtimeData: protectedProcedure
    .input(pushRealtimeDataInput)
    .mutation(async ({ ctx, input }) => {
      await ensureProvider(ctx.db, ctx.userId);

      if (input.samples.length === 0) {
        logger.info("WHOOP BLE realtime push with 0 samples", { userId: ctx.userId });
        return { inserted: 0 };
      }

      const firstTimestamp = input.samples[0]?.timestamp;
      const lastTimestamp = input.samples[input.samples.length - 1]?.timestamp;

      const inserted = await insertRealtimeDataBatch(
        ctx.db,
        ctx.userId,
        input.deviceId,
        input.samples,
      );

      logger.info("WHOOP BLE realtime data pushed", {
        userId: ctx.userId,
        deviceId: input.deviceId,
        sampleCount: inserted,
        firstTimestamp,
        lastTimestamp,
        serverTime: new Date().toISOString(),
      });

      return { inserted };
    }),
});
