import { sql } from "drizzle-orm";
import { z } from "zod";
import { logger } from "../logger.ts";
import { protectedProcedure, router } from "../trpc.ts";

const PROVIDER_ID = "apple_motion";
const INSERT_BATCH_SIZE = 5000;

// ── Zod schemas ──

const accelerometerSampleSchema = z.object({
  timestamp: z.string(), // ISO 8601 with millisecond precision
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

const pushAccelerometerInput = z.object({
  deviceId: z.string().min(1),
  deviceType: z.string().min(1),
  samples: z.array(accelerometerSampleSchema),
});

export type AccelerometerSample = z.infer<typeof accelerometerSampleSchema>;

type Database = Parameters<Parameters<typeof protectedProcedure.mutation>[0]>[0]["ctx"]["db"];

/** Ensure the apple_motion provider row exists */
async function ensureProvider(db: Database) {
  await db.execute(
    sql`INSERT INTO fitness.provider (id, name)
        VALUES (${PROVIDER_ID}, 'Apple Motion')
        ON CONFLICT (id) DO NOTHING`,
  );
}

/**
 * Bulk-insert accelerometer samples using multi-row VALUES.
 * At 50 Hz, a 12-hour sync produces ~2.16M samples.
 * Single-row inserts would be unacceptably slow — multi-row is critical.
 */
async function insertBatch(
  db: Database,
  userId: string,
  deviceId: string,
  deviceType: string,
  samples: AccelerometerSample[],
): Promise<number> {
  if (samples.length === 0) return 0;

  let totalInserted = 0;

  for (let offset = 0; offset < samples.length; offset += INSERT_BATCH_SIZE) {
    const batch = samples.slice(offset, offset + INSERT_BATCH_SIZE);

    const valuesClauses = batch.map(
      (s) =>
        sql`(${s.timestamp}::timestamptz, ${userId}::uuid, ${deviceId}, ${deviceType}, ${PROVIDER_ID}, ${s.x}, ${s.y}, ${s.z})`,
    );

    await db.execute(
      sql`INSERT INTO fitness.accelerometer_sample
          (recorded_at, user_id, device_id, device_type, provider_id, x, y, z)
          VALUES ${sql.join(valuesClauses, sql`, `)}`,
    );

    totalInserted += batch.length;
  }

  return totalInserted;
}

// ── Router ──

export const accelerometerSyncRouter = router({
  pushAccelerometerSamples: protectedProcedure
    .input(pushAccelerometerInput)
    .mutation(async ({ ctx, input }) => {
      await ensureProvider(ctx.db);

      if (input.samples.length === 0) {
        logger.info("Accelerometer push with 0 samples", {
          userId: ctx.userId,
          deviceId: input.deviceId,
          deviceType: input.deviceType,
        });
        return { inserted: 0 };
      }

      // Log timestamp range to detect stale/future data
      const firstTimestamp = input.samples[0]?.timestamp;
      const lastTimestamp = input.samples[input.samples.length - 1]?.timestamp;
      const nowIso = new Date().toISOString();

      const inserted = await insertBatch(
        ctx.db,
        ctx.userId,
        input.deviceId,
        input.deviceType,
        input.samples,
      );

      logger.info("Accelerometer samples pushed", {
        userId: ctx.userId,
        deviceId: input.deviceId,
        deviceType: input.deviceType,
        sampleCount: inserted,
        firstTimestamp,
        lastTimestamp,
        serverTime: nowIso,
      });

      return { inserted };
    }),
});
