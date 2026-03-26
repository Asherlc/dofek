import { sql } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc.ts";

const PROVIDER_ID = "dofek";
const BATCH_SIZE = 500;

const gpsSampleSchema = z.object({
  recordedAt: z.string(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  gpsAccuracy: z.number().nullable(),
  altitude: z.number().nullable(),
  speed: z.number().nullable(),
});

const saveActivitySchema = z.object({
  activityType: z.string().min(1),
  startedAt: z.string(),
  endedAt: z.string(),
  name: z.string().nullable(),
  notes: z.string().nullable(),
  sourceName: z.string(),
  samples: z.array(gpsSampleSchema),
});

type Database = Parameters<Parameters<typeof protectedProcedure.mutation>[0]>[0]["ctx"]["db"];

async function ensureProvider(db: Database) {
  await db.execute(
    sql`INSERT INTO fitness.provider (id, name)
        VALUES (${PROVIDER_ID}, 'Dofek')
        ON CONFLICT (id) DO NOTHING`,
  );
}

export const activityRecordingRouter = router({
  save: protectedProcedure.input(saveActivitySchema).mutation(async ({ ctx, input }) => {
    await ensureProvider(ctx.db);

    const externalId = `dofek:${input.startedAt}:${ctx.userId}`;

    // Insert activity, returning the ID
    const rows = await ctx.db.execute<{ id: string }>(
      sql`INSERT INTO fitness.activity (
              user_id, provider_id, external_id, activity_type,
              started_at, ended_at, name, notes, source_name
            )
            VALUES (
              ${ctx.userId},
              ${PROVIDER_ID},
              ${externalId},
              ${input.activityType},
              ${input.startedAt}::timestamptz,
              ${input.endedAt}::timestamptz,
              ${input.name},
              ${input.notes},
              ${input.sourceName}
            )
            ON CONFLICT (provider_id, external_id) DO UPDATE SET
              activity_type = EXCLUDED.activity_type,
              started_at = EXCLUDED.started_at,
              ended_at = EXCLUDED.ended_at,
              name = EXCLUDED.name,
              notes = EXCLUDED.notes,
              source_name = EXCLUDED.source_name
            RETURNING id`,
    );

    const row = rows[0];
    if (!row) throw new Error("Failed to insert activity");
    const activityId = String(row.id);

    // Batch-insert GPS samples into metric_stream
    for (let i = 0; i < input.samples.length; i += BATCH_SIZE) {
      const batch = input.samples.slice(i, i + BATCH_SIZE);

      if (batch.length === 0) continue;

      const values = batch.map(
        (s) =>
          sql`(
              ${s.recordedAt}::timestamptz,
              ${ctx.userId},
              ${activityId}::uuid,
              ${PROVIDER_ID},
              ${s.lat},
              ${s.lng},
              ${s.gpsAccuracy},
              ${s.altitude},
              ${s.speed},
              ${input.sourceName}
            )`,
      );

      await ctx.db.execute(
        sql`INSERT INTO fitness.metric_stream (
                recorded_at, user_id, activity_id, provider_id,
                lat, lng, gps_accuracy, altitude, speed, source_name
              )
              VALUES ${sql.join(values, sql`, `)}`,
      );
    }

    return { activityId };
  }),
});
