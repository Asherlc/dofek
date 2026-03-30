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
  rawPayloadHex: z.string(),
});

const pushRealtimeDataInput = z.object({
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
 * Bulk-insert realtime data samples into whoop_ble_realtime_data.
 * Also writes HR values to metric_stream for unified HR queries.
 */
async function insertRealtimeDataBatch(
  database: Database,
  userId: string,
  samples: WhoopBleRealtimeDataSample[],
): Promise<number> {
  if (samples.length === 0) return 0;

  let totalInserted = 0;

  for (let offset = 0; offset < samples.length; offset += INSERT_BATCH_SIZE) {
    const batch = samples.slice(offset, offset + INSERT_BATCH_SIZE);

    // Insert into whoop_ble_realtime_data (full raw record)
    const realtimeValues = batch.map(
      (sample) =>
        sql`(${sample.timestamp}::timestamptz, ${userId}::uuid, ${PROVIDER_ID}, ${sample.heartRate}, ${sample.quaternionW}, ${sample.quaternionX}, ${sample.quaternionY}, ${sample.quaternionZ}, ${sample.rawPayloadHex})`,
    );

    await database.execute(
      sql`INSERT INTO fitness.whoop_ble_realtime_data
          (recorded_at, user_id, provider_id, heart_rate, quaternion_w, quaternion_x, quaternion_y, quaternion_z, raw_payload)
          VALUES ${sql.join(realtimeValues, sql`, `)}`,
    );

    // Also insert HR into metric_stream for unified HR queries across providers.
    // Only insert samples where HR > 0 (0 means no reading).
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

      const inserted = await insertRealtimeDataBatch(ctx.db, ctx.userId, input.samples);

      logger.info("WHOOP BLE realtime data pushed", {
        userId: ctx.userId,
        sampleCount: inserted,
        firstTimestamp,
        lastTimestamp,
        serverTime: new Date().toISOString(),
      });

      return { inserted };
    }),
});
