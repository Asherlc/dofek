import { sql } from "drizzle-orm";
import { z } from "zod";
import { logger } from "../logger.ts";
import { protectedProcedure, router } from "../trpc.ts";

const PROVIDER_ID = "apple_motion";
const INSERT_BATCH_SIZE = 5000;

// ── Zod schemas ──

const inertialMeasurementUnitSampleSchema = z.object({
  timestamp: z.string(), // ISO 8601 with millisecond precision
  x: z.number(),
  y: z.number(),
  z: z.number(),
  gyroscopeX: z.number().optional(),
  gyroscopeY: z.number().optional(),
  gyroscopeZ: z.number().optional(),
});

const pushSamplesInput = z.object({
  deviceId: z.string().min(1),
  deviceType: z.string().min(1),
  samples: z.array(inertialMeasurementUnitSampleSchema),
});

export type InertialMeasurementUnitSample = z.infer<typeof inertialMeasurementUnitSampleSchema>;

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
 * Bulk-insert IMU samples using multi-row VALUES.
 * At 50 Hz, a 12-hour sync produces ~2.16M samples.
 * Single-row inserts would be unacceptably slow — multi-row is critical.
 */
async function insertBatch(
  db: Database,
  userId: string,
  deviceId: string,
  deviceType: string,
  samples: InertialMeasurementUnitSample[],
): Promise<number> {
  if (samples.length === 0) return 0;

  let totalInserted = 0;

  for (let offset = 0; offset < samples.length; offset += INSERT_BATCH_SIZE) {
    const batch = samples.slice(offset, offset + INSERT_BATCH_SIZE);

    // Write IMU vectors directly to sensor_sample: accel-only as 'accel', 6-axis as 'imu'.
    const sensorValuesClauses = batch.map((sample) => {
      const sampleHasGyro =
        sample.gyroscopeX != null || sample.gyroscopeY != null || sample.gyroscopeZ != null;
      const channel = sampleHasGyro ? "imu" : "accel";
      const vector = sampleHasGyro
        ? sql`ARRAY[${sample.x}, ${sample.y}, ${sample.z}, ${sample.gyroscopeX ?? 0}, ${sample.gyroscopeY ?? 0}, ${sample.gyroscopeZ ?? 0}]::real[]`
        : sql`ARRAY[${sample.x}, ${sample.y}, ${sample.z}]::real[]`;
      return sql`(${sample.timestamp}::timestamptz, ${userId}::uuid, ${PROVIDER_ID}, ${deviceId}, ${"ble"}, ${channel}, ${vector})`;
    });
    await db.execute(
      sql`INSERT INTO fitness.sensor_sample
          (recorded_at, user_id, provider_id, device_id, source_type, channel, vector)
          VALUES ${sql.join(sensorValuesClauses, sql`, `)}`,
    );

    totalInserted += batch.length;
  }

  return totalInserted;
}

// ── Router ──

export const inertialMeasurementUnitSyncRouter = router({
  pushSamples: protectedProcedure.input(pushSamplesInput).mutation(async ({ ctx, input }) => {
    await ensureProvider(ctx.db);

    if (input.samples.length === 0) {
      logger.info("IMU push with 0 samples", {
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

    logger.info("IMU samples pushed", {
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
