import { resolveProviderActivityType } from "@dofek/training/activity-types";
import * as Sentry from "@sentry/node";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import { activity } from "../src/db/schema/activity.ts";
import { executeWithSchema, timestampStringSchema } from "../src/db/typed-sql.ts";
import { replaceHangTenIntervals } from "../src/providers/apple-health/hang-ten-intervals.ts";
import { applyWorkoutMetadata } from "../src/providers/apple-health/workouts.ts";

const hangTenWorkoutRowSchema = z.object({
  id: z.string(),
  started_at: timestampStringSchema,
  ended_at: timestampStringSchema,
  raw: z
    .object({
      metadata: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    })
    .passthrough(),
});

function initializeSentry(): void {
  const sentryDsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
  if (sentryDsn) {
    Sentry.init({ dsn: sentryDsn, skipOpenTelemetrySetup: true });
  }
}

export async function backfillHangTenWorkouts(execute: boolean): Promise<number> {
  const db = createDatabaseFromEnv();
  try {
    const rows = await executeWithSchema(
      db,
      hangTenWorkoutRowSchema,
      sql`SELECT id::text, started_at::text, ended_at::text, raw
           FROM fitness.activity
           WHERE provider_id = 'apple_health'
             AND canonical_type = 'strength'
             AND raw->'metadata'->>'HKMetadataKeyWorkoutBrandName' = 'Hang Ten'
             AND NULLIF(raw->'metadata'->>'HangTen.PlanName', '') IS NOT NULL`,
    );
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
  initializeSentry();
  try {
    const result = await backfillHangTenWorkouts(args.includes("--execute"));
    console.log(
      `[hang-ten-workout-backfill] ${args.includes("--execute") ? "updated" : "found"} ${result} workouts`,
    );
  } catch (error: unknown) {
    Sentry.captureException(error);
    throw error;
  } finally {
    await Sentry.close(2_000);
  }
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectExecution) {
  main().catch((error: unknown) => {
    console.error(`[hang-ten-workout-backfill] ${error}`);
    process.exit(1);
  });
}
