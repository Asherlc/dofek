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

    const valuesClauses = batch.map(
      (sample) =>
        sql`(${sample.timestamp}::timestamptz, ${userId}::uuid, ${deviceId}, ${deviceType}, ${PROVIDER_ID}, ${sample.x}, ${sample.y}, ${sample.z}, ${sample.gyroscopeX ?? null}, ${sample.gyroscopeY ?? null}, ${sample.gyroscopeZ ?? null})`,
    );

    await db.execute(
      sql`INSERT INTO fitness.inertial_measurement_unit_sample
          (recorded_at, user_id, device_id, device_type, provider_id, x, y, z, gyroscope_x, gyroscope_y, gyroscope_z)
          VALUES ${sql.join(valuesClauses, sql`, `)}`,
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
      return { inserted: 0 };
    }

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
    });

    return { inserted };
  }),
});
