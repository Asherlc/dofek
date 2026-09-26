import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import { setupTestDatabase } from "../../../../src/db/test-helpers.ts";
import {
  clickHouseActivityCalendarDate,
  postgresActivityCalendarDate,
} from "./activity-local-date.ts";

it("keeps date-only Mountain Project sessions on their export day in both databases", async () => {
  const postgres = await setupTestDatabase();
  const clickhouse = createClickHouseClientFromEnv();
  try {
    const pgRows = await postgres.db.execute(sql`
      SELECT provider_id, ${postgresActivityCalendarDate(sql`activity`, "America/Los_Angeles")}::text AS activity_date
      FROM (VALUES
        ('mountain-project', '2026-09-26 00:00:00+00'::timestamptz),
        ('kaya', '2026-09-26 00:00:00+00'::timestamptz),
        ('kaya', '2026-09-26 18:00:00+00'::timestamptz)
      ) AS activity(provider_id, started_at)
    `);
    const chResult = await clickhouse.query({
      query: `SELECT provider_id, toString(${clickHouseActivityCalendarDate("activity")}) AS activity_date
        FROM (SELECT 'mountain-project' AS provider_id, toDateTime64('2026-09-26 00:00:00', 6, 'UTC') AS started_at
          UNION ALL SELECT 'kaya', toDateTime64('2026-09-26 00:00:00', 6, 'UTC')
          UNION ALL SELECT 'kaya', toDateTime64('2026-09-26 18:00:00', 6, 'UTC')) AS activity`,
      query_params: { timezone: "America/Los_Angeles" },
      format: "JSONEachRow",
    });
    const expected = [
      { provider_id: "mountain-project", activity_date: "2026-09-26" },
      { provider_id: "kaya", activity_date: "2026-09-25" },
      { provider_id: "kaya", activity_date: "2026-09-26" },
    ];
    expect(pgRows).toEqual(expect.arrayContaining(expected));
    expect(await chResult.json()).toEqual(expect.arrayContaining(expected));
  } finally {
    await clickhouse.close();
    await postgres.cleanup();
  }
});
