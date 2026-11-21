import { runningRaceResult } from "dofek/db/schema/activity";
import { inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { executeWithSchema, type SqlExecutor } from "../lib/typed-sql.ts";

const eligibleMeters = [5000, 8046.72, 10000, 16093.44];

export const runningRaceForecastSourceSchema = z.object({
  provider_id: z.string(),
  source_activity_id: z.string(),
  source_name: z.string().nullable(),
  source_date_time: z.iso.datetime({ offset: true, local: true }),
  date: dateSchema,
  distance_meters: z.number().positive(),
  finish_seconds: z.number().positive(),
});

export async function readRunningRaceForecastSource(
  db: SqlExecutor,
  userId: string,
  range: { startDate: string; endDate: string; targetMeters: number },
) {
  const eventDate = sql`left(${runningRaceResult.sourceDateTime}, 10)`;
  const [source] = await executeWithSchema(
    db,
    runningRaceForecastSourceSchema,
    sql`SELECT provider_id, source_activity_id, source_name, source_date_time,
               ${eventDate} AS date, distance_meters, finish_seconds
        FROM ${runningRaceResult}
        WHERE user_id = ${userId}::uuid
          AND ${eventDate} BETWEEN ${range.startDate} AND ${range.endDate}
          AND ${inArray(runningRaceResult.distanceMeters, eligibleMeters)}
          AND distance_meters < ${range.targetMeters}
        ORDER BY distance_meters DESC, date DESC, provider_id, source_activity_id
        LIMIT 1`,
  );
  return source;
}
