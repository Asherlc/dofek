import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEST_USER_ID } from "./schema/core.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { executeWithSchema } from "./typed-sql.ts";

const mergedActivitySchema = z.object({
  provider_id: z.string(),
  source_name: z.string().nullable(),
  name: z.string().nullable(),
  notes: z.string().nullable(),
  member_activity_ids: z.array(z.string()),
});

describe("Zepp activity priority", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`INSERT INTO fitness.provider (id, name) VALUES
      ('apple_health', 'Apple Health'), ('amazfit-zepp', 'Amazfit / Zepp'),
      ('whoop', 'WHOOP'), ('peloton', 'Peloton'), ('strava', 'Strava'), ('wahoo', 'Wahoo')
      ON CONFLICT (id) DO NOTHING`);
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  it.each([
    { providerId: "apple_health", activityType: "hiking" },
    { providerId: "apple_health", activityType: "cycling" },
    { providerId: "amazfit-zepp", activityType: "hiking" },
    { providerId: "amazfit-zepp", activityType: "cycling" },
  ])("prefers $providerId Zepp for overlapping $activityType records", async (scenario) => {
    const groupId = randomUUID();
    const zeppId = randomUUID();
    const zeppName = `Zepp ${scenario.activityType}`;
    await context.db.execute(sql`INSERT INTO fitness.activity_group (id, user_id)
      VALUES (${groupId}, ${TEST_USER_ID})`);

    const sources = [
      { providerId: "apple_health", sourceName: "AllTrails" },
      { providerId: "apple_health", sourceName: "WHOOP" },
      { providerId: "whoop", sourceName: "WHOOP" },
      { providerId: "peloton", sourceName: "Peloton" },
      { providerId: "strava", sourceName: "Strava" },
      { providerId: "wahoo", sourceName: "Wahoo" },
    ];
    for (const source of sources) {
      await context.db.execute(sql`INSERT INTO fitness.activity (
        group_id, provider_id, user_id, external_id, canonical_type, provider_type,
        started_at, ended_at, source_name, name, notes
      ) VALUES (
        ${groupId}, ${source.providerId}, ${TEST_USER_ID}, ${randomUUID()},
        ${scenario.activityType}::fitness.canonical_activity_type, 'Recorded workout',
        '2026-10-17T16:53:00Z', '2026-10-17T20:45:26Z',
        ${source.sourceName}, ${source.sourceName},
        ${source.providerId === "peloton" ? "Recorded route notes" : null}
      )`);
    }
    await context.db.execute(sql`INSERT INTO fitness.activity (
      id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
      started_at, ended_at, source_name, name
    ) VALUES (
      ${zeppId}, ${groupId}, ${scenario.providerId}, ${TEST_USER_ID}, ${randomUUID()},
      ${scenario.activityType}::fitness.canonical_activity_type, 'Recorded workout',
      '2026-10-17T16:53:00Z', '2026-10-17T20:45:26Z', 'Zepp', ${zeppName}
    )`);

    const rows = await executeWithSchema(
      context.db,
      mergedActivitySchema,
      sql`SELECT provider_id, source_name, name, notes, member_activity_ids
        FROM fitness.v_activity WHERE id = ${groupId}`,
    );
    expect(rows).toEqual([
      {
        provider_id: scenario.providerId,
        source_name: "Zepp",
        name: zeppName,
        notes: "Recorded route notes",
        member_activity_ids: expect.arrayContaining([zeppId]),
      },
    ]);
    expect(rows[0]?.member_activity_ids).toHaveLength(sources.length + 1);
  });

  it("preserves existing health-domain preferences when promoting activity priority", async () => {
    await context.db.execute(sql`UPDATE fitness.provider_priority SET
      priority = 55, sleep_priority = 9, body_priority = NULL,
      recovery_priority = 17, daily_activity_priority = NULL
      WHERE provider_id = 'amazfit-zepp'`);
    await context.db.execute(sql`UPDATE fitness.device_priority SET
      sleep_priority = 4, body_priority = 14, recovery_priority = 24,
      daily_activity_priority = 34
      WHERE provider_id = 'apple_health' AND source_name_pattern = 'Zepp'`);

    const migration = readFileSync(
      new URL("../../drizzle/0149_zepp_activity_priority.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      await context.db.execute(sql.raw(statement));
    }

    const priorities = await executeWithSchema(
      context.db,
      z.object({
        provider_id: z.string(),
        priority: z.number(),
        sleep_priority: z.number(),
        body_priority: z.number(),
        recovery_priority: z.number(),
        daily_activity_priority: z.number(),
      }),
      sql`SELECT provider_id, priority, sleep_priority, body_priority,
        recovery_priority, daily_activity_priority FROM fitness.provider_priority
        WHERE provider_id = 'amazfit-zepp'
        UNION ALL
        SELECT provider_id, priority, sleep_priority, body_priority,
        recovery_priority, daily_activity_priority FROM fitness.device_priority
        WHERE provider_id = 'apple_health' AND source_name_pattern = 'Zepp'`,
    );
    expect(priorities).toEqual([
      {
        provider_id: "amazfit-zepp",
        priority: 1,
        sleep_priority: 9,
        body_priority: 55,
        recovery_priority: 17,
        daily_activity_priority: 55,
      },
      {
        provider_id: "apple_health",
        priority: 1,
        sleep_priority: 4,
        body_priority: 14,
        recovery_priority: 24,
        daily_activity_priority: 34,
      },
    ]);
  });
});
