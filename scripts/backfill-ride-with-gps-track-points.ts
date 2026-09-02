import { pathToFileURL } from "node:url";
import type { ProviderActivityType } from "@dofek/training/activity-types";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createDatabaseFromEnv, type Database } from "../src/db/index.ts";
import { replaceMetricStreamBatch } from "../src/db/metric-stream-writer.ts";
import { SOURCE_TYPE_API } from "../src/db/sensor-channels.ts";
import { runWithTokenUser } from "../src/db/token-user-context.ts";
import {
  buildRideWithGpsMetricRows,
  mapActivityType,
  type RideWithGpsTrackPoint,
} from "../src/providers/ride-with-gps.ts";

interface BackfillOptions {
  execute: boolean;
  userId?: string;
  start?: Date;
  end?: Date;
  limit?: number;
}

interface RideWithGpsActivityRow {
  id: string;
  externalId: string;
  userId: string;
  canonicalType: string;
  providerType: string;
  modality: string | null;
  raw: unknown;
}

export interface RideWithGpsActivityBackfillPlan {
  id: string;
  externalId: string;
  userId: string;
  activityType: ProviderActivityType;
  shouldUpdateActivityType: boolean;
  metricRows: ReturnType<typeof buildRideWithGpsMetricRows>;
}

const storedTrackPointSchema = z
  .object({
    longitude: z.number().optional(),
    latitude: z.number().optional(),
    distanceMeters: z.number().optional(),
    elevationMeters: z.number().optional(),
    epochSeconds: z.number().optional(),
    speedMetersPerSecond: z.number().optional(),
    speedKph: z.number().optional(),
    temperatureCelsius: z.number().optional(),
    heartRateBpm: z.number().optional(),
    cadenceRpm: z.number().optional(),
    powerWatts: z.number().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    d: z.number().optional(),
    e: z.number().optional(),
    t: z.number().optional(),
    s: z.number().optional(),
    T: z.number().optional(),
    h: z.number().optional(),
    c: z.number().optional(),
    p: z.number().optional(),
  })
  .passthrough()
  .transform(
    (point): RideWithGpsTrackPoint => ({
      longitude: point.longitude ?? point.x,
      latitude: point.latitude ?? point.y,
      distanceMeters: point.distanceMeters ?? point.d,
      elevationMeters: point.elevationMeters ?? point.e,
      epochSeconds: point.epochSeconds ?? point.t,
      speedMetersPerSecond: point.speedMetersPerSecond ?? point.speedKph ?? point.s,
      temperatureCelsius: point.temperatureCelsius ?? point.T,
      heartRateBpm: point.heartRateBpm ?? point.h,
      cadenceRpm: point.cadenceRpm ?? point.c,
      powerWatts: point.powerWatts ?? point.p,
    }),
  );

const storedRawSchema = z
  .object({
    activity_type: z.string().nullable().optional(),
    track_points: z.array(storedTrackPointSchema).default([]),
  })
  .passthrough();

const activityRowSchema = z.object({
  id: z.string(),
  externalId: z.string(),
  userId: z.string(),
  canonicalType: z.string(),
  providerType: z.string(),
  modality: z.string().nullable(),
  raw: z.unknown(),
});

const userRowSchema = z.object({
  userId: z.string(),
  activityCount: z.number(),
});

function parseDateArgument(value: string, name: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${name} must be an ISO date or timestamp`);
  }
  return date;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function readOptionValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function parseArgs(args: string[]): BackfillOptions {
  const options: BackfillOptions = { execute: false };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--execute") {
      options.execute = true;
      continue;
    }
    if (arg === "--user-id") {
      options.userId = readOptionValue(args, index, arg);
      index++;
      continue;
    }
    if (arg === "--start") {
      options.start = parseDateArgument(readOptionValue(args, index, arg), arg);
      index++;
      continue;
    }
    if (arg === "--end") {
      options.end = parseDateArgument(readOptionValue(args, index, arg), arg);
      index++;
      continue;
    }
    if (arg === "--limit") {
      options.limit = parsePositiveInteger(readOptionValue(args, index, arg), arg);
      index++;
      continue;
    }
    if (arg === "--help") {
      throw new Error(usage());
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function planRideWithGpsActivityBackfill(
  rowInput: unknown,
): RideWithGpsActivityBackfillPlan {
  const row = activityRowSchema.parse(rowInput);
  const raw = storedRawSchema.parse(row.raw);
  const activityType = mapActivityType(raw.activity_type);

  return {
    id: row.id,
    externalId: row.externalId,
    userId: row.userId,
    activityType,
    shouldUpdateActivityType:
      row.canonicalType !== activityType.canonicalType ||
      row.providerType !== activityType.providerType ||
      row.modality !== activityType.modality,
    metricRows: buildRideWithGpsMetricRows({
      activityId: row.id,
      externalId: row.externalId,
      activityType,
      trackPoints: raw.track_points,
    }),
  };
}

async function resolveUserId(db: Database, userId: string | undefined): Promise<string> {
  if (userId) return userId;

  const rows = z.array(userRowSchema).parse(
    await db.execute(sql`
      SELECT user_id::text AS "userId", count(*)::int AS "activityCount"
      FROM fitness.activity
      WHERE provider_id = 'ride-with-gps'
      GROUP BY user_id
      ORDER BY "activityCount" DESC
    `),
  );

  if (rows.length === 1 && rows[0]) return rows[0].userId;

  throw new Error(
    `Expected exactly one RideWithGPS user, found ${rows.length}. Pass --user-id explicitly.`,
  );
}

async function loadActivityRows(
  db: Database,
  options: BackfillOptions & { userId: string },
): Promise<RideWithGpsActivityRow[]> {
  const conditions = [
    sql`provider_id = 'ride-with-gps'`,
    sql`user_id = ${options.userId}`,
    sql`provider_absent_at IS NULL`,
    sql`raw ? 'track_points'`,
  ];

  if (options.start) conditions.push(sql`started_at >= ${options.start}`);
  if (options.end) conditions.push(sql`started_at < ${options.end}`);

  const limitClause = options.limit ? sql`LIMIT ${options.limit}` : sql``;
  const rows = await db.execute(sql`
    SELECT id::text AS id,
           external_id AS "externalId",
           user_id::text AS "userId",
           canonical_type AS "canonicalType",
           provider_type AS "providerType",
           modality::text AS modality,
           raw
    FROM fitness.activity
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY started_at ASC
    ${limitClause}
  `);

  return z.array(activityRowSchema).parse(rows);
}

export async function applyRideWithGpsActivityBackfillPlan(
  db: Pick<Database, "execute">,
  plan: RideWithGpsActivityBackfillPlan,
): Promise<number> {
  if (plan.shouldUpdateActivityType) {
    await db.execute(sql`
      UPDATE fitness.activity
      SET canonical_type = ${plan.activityType.canonicalType},
          provider_type = ${plan.activityType.providerType},
          modality = ${plan.activityType.modality}
      WHERE id = ${plan.id}
    `);
  }

  const result = await replaceMetricStreamBatch(
    db,
    { activityId: plan.id, userId: plan.userId },
    plan.metricRows,
    SOURCE_TYPE_API,
  );
  return result.rowCount;
}

async function runBackfill(options: BackfillOptions): Promise<void> {
  const db = createDatabaseFromEnv();
  const userId = await resolveUserId(db, options.userId);
  const rows = await loadActivityRows(db, { ...options, userId });
  const plans = rows.map(planRideWithGpsActivityBackfill);
  const rowsWithMetricData = plans.filter((plan) => plan.metricRows.length > 0);
  const activityTypeUpdates = plans.filter((plan) => plan.shouldUpdateActivityType);
  const metricSourceRows = rowsWithMetricData.reduce(
    (total, plan) => total + plan.metricRows.length,
    0,
  );

  console.log(
    JSON.stringify(
      {
        mode: options.execute ? "execute" : "dry-run",
        userId,
        activitiesScanned: rows.length,
        activitiesWithMetricRows: rowsWithMetricData.length,
        activityTypeUpdates: activityTypeUpdates.length,
        metricSourceRows,
      },
      null,
      2,
    ),
  );

  if (!options.execute) return;

  let publishedRows = 0;
  await runWithTokenUser(userId, async () => {
    for (const plan of plans) {
      publishedRows += await applyRideWithGpsActivityBackfillPlan(db, plan);
    }
  });

  console.log(JSON.stringify({ publishedRows }, null, 2));
}

function usage(): string {
  return [
    "Usage: pnpm tsx scripts/backfill-ride-with-gps-track-points.ts [options]",
    "",
    "Options:",
    "  --execute        Publish metric stream replacements and update activity types.",
    "  --user-id ID     User id to backfill. Required when multiple RWGPS users exist.",
    "  --start DATE     Inclusive activity start date filter.",
    "  --end DATE       Exclusive activity start date filter.",
    "  --limit N        Limit activities for a canary run.",
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runBackfill(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
