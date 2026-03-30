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
async function ensureProvider(database: Database) {
  await database.execute(
    sql`INSERT INTO fitness.provider (id, name)
        VALUES (${PROVIDER_ID}, 'WHOOP BLE')
        ON CONFLICT (id) DO NOTHING`,
  );
}

/**
 * Insert HR into metric_stream and quaternion into orientation_sample.
 * No duplicate data — each value lives in exactly one table.
 */
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

    // Insert HR into metric_stream (only for samples with a valid reading)
    const heartRateSamples = batch.filter((sample) => sample.heartRate > 0);
    if (heartRateSamples.length > 0) {
      const metricValues = heartRateSamples.map(
        (sample) =>
          sql`(${sample.timestamp}::timestamptz, ${userId}::uuid, ${PROVIDER_ID}, ${sample.heartRate}, ${"WHOOP BLE"})`,
      );

      await database.execute(
        sql`INSERT INTO fitness.metric_stream
            (recorded_at, user_id, provider_id, heart_rate, source_name)
            VALUES ${sql.join(metricValues, sql`, `)}`,
      );
    }

    // Insert quaternion into orientation_sample
    const orientationValues = batch.map(
      (sample) =>
        sql`(${sample.timestamp}::timestamptz, ${userId}::uuid, ${PROVIDER_ID}, ${deviceId}, ${sample.quaternionW}, ${sample.quaternionX}, ${sample.quaternionY}, ${sample.quaternionZ})`,
    );

    await database.execute(
      sql`INSERT INTO fitness.orientation_sample
          (recorded_at, user_id, provider_id, device_id, quaternion_w, quaternion_x, quaternion_y, quaternion_z)
          VALUES ${sql.join(orientationValues, sql`, `)}`,
    );

    totalInserted += batch.length;
  }

  return totalInserted;
}

// ── Router ──

export const whoopBleSyncRouter = router({
  pushRealtimeData: protectedProcedure
    .input(pushRealtimeDataInput)
    .mutation(async ({ ctx, input }) => {
      await ensureProvider(ctx.db);

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

      // Log optical/PPG data for analysis — sample every 30th to avoid log spam
      const samplesWithOptical = input.samples.filter(
        (sample) => sample.opticalRawHex !== "0".repeat(36),
      );
      if (samplesWithOptical.length > 0) {
        const sampled = samplesWithOptical.filter((_, index) => index % 30 === 0);
        for (const sample of sampled) {
          logger.info("WHOOP BLE optical/PPG data", {
            userId: ctx.userId,
            timestamp: sample.timestamp,
            heartRate: sample.heartRate,
            opticalRawHex: sample.opticalRawHex,
          });
        }
        logger.info("WHOOP BLE optical summary", {
          userId: ctx.userId,
          totalSamples: input.samples.length,
          samplesWithOptical: samplesWithOptical.length,
        });
      }

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
