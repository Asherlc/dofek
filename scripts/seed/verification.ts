import { z } from "zod";
import type { TaggedQueryClient } from "../../src/db/tagged-query-client.ts";
import { USER_ID } from "./helpers.ts";

const countRowSchema = z.object({
  count: z.number().int().nonnegative(),
});

export async function verifySeed(sql: TaggedQueryClient): Promise<void> {
  const minimums = [
    [
      "providers",
      5,
      `SELECT COUNT(*)::int AS count FROM fitness.provider_connection WHERE user_id = '${USER_ID}'`,
    ],
    [
      "daily metrics",
      170,
      `SELECT COUNT(*)::int AS count FROM fitness.daily_metrics WHERE user_id = '${USER_ID}'`,
    ],
    [
      "sleep sessions",
      100,
      `SELECT COUNT(*)::int AS count FROM fitness.sleep_session WHERE user_id = '${USER_ID}'`,
    ],
    [
      "activities",
      90,
      `SELECT COUNT(*)::int AS count FROM fitness.activity WHERE user_id = '${USER_ID}'`,
    ],
    [
      "nutrition days",
      85,
      `SELECT COUNT(DISTINCT date)::int AS count FROM fitness.food_entry WHERE user_id = '${USER_ID}'`,
    ],
    [
      "food entries",
      20,
      `SELECT COUNT(*)::int AS count FROM fitness.food_entry WHERE user_id = '${USER_ID}'`,
    ],
    [
      "lab results",
      8,
      `SELECT COUNT(*)::int AS count FROM fitness.lab_result WHERE user_id = '${USER_ID}'`,
    ],
    [
      "journal entries",
      30,
      `SELECT COUNT(*)::int AS count FROM fitness.journal_entry WHERE user_id = '${USER_ID}'`,
    ],
    [
      "breathwork sessions",
      10,
      `SELECT COUNT(*)::int AS count FROM fitness.breathwork_session WHERE user_id = '${USER_ID}'`,
    ],
    [
      "cycle periods",
      4,
      `SELECT COUNT(*)::int AS count FROM fitness.menstrual_period WHERE user_id = '${USER_ID}'`,
    ],
  ] as const;

  console.log("\nVerification:");
  for (const [label, minimum, query] of minimums) {
    const count = await readCount(sql, query);
    if (count < minimum) {
      throw new Error(
        `Seed verification failed for ${label}: expected at least ${minimum}, got ${count}`,
      );
    }
    console.log(`  ${label}: ${count}`);
  }
}

async function readCount(sql: TaggedQueryClient, query: string): Promise<number> {
  const [row] = await sql.unsafe(query);
  if (!row) throw new Error(`Count query returned no rows: ${query}`);
  return countRowSchema.parse(row).count;
}
