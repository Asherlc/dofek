import { resolveProviderActivityType } from "@dofek/training/activity-types";
import * as Sentry from "@sentry/node";
import { eq, sql } from "drizzle-orm";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import { activity } from "../src/db/schema/activity.ts";
import { replaceHangTenIntervals } from "../src/providers/apple-health/hang-ten-intervals.ts";
import { applyWorkoutMetadata } from "../src/providers/apple-health/workouts.ts";

export async function backfillHangTenWorkouts(execute: boolean): Promise<number> {
  const db = createDatabaseFromEnv();
  try {
    const rows = await db.execute<{
      id: string;
      started_at: string;
      ended_at: string;
      raw: { metadata?: Record<string, string | number> };
    }>(sql`SELECT id::text, started_at::text, ended_at::text, raw
           FROM fitness.activity
           WHERE provider_id = 'apple_health'
             AND canonical_type = 'strength'
             AND raw->'metadata'->>'HKMetadataKeyWorkoutBrandName' = 'Hang Ten'
             AND NULLIF(raw->'metadata'->>'HangTen.PlanName', '') IS NOT NULL`);
    if (!execute) return rows.length;

    for (const row of rows) {
      const workout = applyWorkoutMetadata(
        {
          activityType: resolveProviderActivityType("20", "functional_strength"),
          sourceName: "Hang Ten",
          durationSeconds: 0,
          startDate: new Date(row.started_at),
          endDate: new Date(row.ended_at),
        },
        row.raw.metadata ?? {},
      );
      if (!workout.hangTen)
        throw new Error(`Hang Ten metadata could not be normalized for ${row.id}`);
      await db.transaction(async (transaction) => {
        await transaction
          .update(activity)
          .set({
            canonicalType: workout.activityType.canonicalType,
            providerType: workout.activityType.providerType,
            modality: workout.activityType.modality,
            name: workout.hangTen?.planName,
            sourceName: workout.sourceName,
            raw: { ...row.raw, hangTen: workout.hangTen },
          })
          .where(eq(activity.id, row.id));
        await replaceHangTenIntervals(transaction, row.id, workout);
      });
    }
    return rows.length;
  } finally {
    await db.$client.end();
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.some((argument) => argument !== "--execute")) {
    throw new Error("Usage: pnpm tsx scripts/backfill-hang-ten-workouts.ts [--execute]");
  }
  const result = await backfillHangTenWorkouts(args.includes("--execute"));
  console.log(
    `[hang-ten-workout-backfill] ${args.includes("--execute") ? "updated" : "found"} ${result} workouts`,
  );
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectExecution) {
  main().catch(async (error: unknown) => {
    Sentry.captureException(error);
    console.error(`[hang-ten-workout-backfill] ${error}`);
    await Sentry.close(2_000);
    process.exit(1);
  });
}
