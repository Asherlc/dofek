import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import { setupTestDatabase } from "../../../../src/db/test-helpers.ts";
import {
  clickHouseActivityCalendarDate,
  postgresActivityCalendarDate,
} from "./activity-local-date.ts";

const activityDateRowSchema = z.object({
  provider_id: z.string(),
  activity_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

it("keeps date-only Mountain Project sessions on their export day in both databases", async () => {
  const postgres = await setupTestDatabase();
  const clickhouse = createClickHouseClientFromEnv();
  try {
    const pgRows = await postgres.db.execute(sql`
      SELECT provider_id, ${postgresActivityCalendarDate(sql`activity`, "America/Los_Angeles")}::text AS activity_date
      FROM (VALUES
        ('mountain-project'::text, '2026-09-26 00:00:00+00'::timestamptz, 'unknown'::text, NULL::integer),
        ('kaya'::text, '2026-09-26 00:00:00+00'::timestamptz, 'unknown'::text, NULL::integer),
        ('kaya'::text, '2026-09-26 18:00:00+00'::timestamptz, 'unknown'::text, NULL::integer),
        ('kaya'::text, '2026-09-26 06:00:00+00'::timestamptz, 'provider_timezone'::text, 120::integer)
      ) AS activity(provider_id, started_at, local_time_source, start_utc_offset_minutes)
    `);
    const chResult = await clickhouse.query({
      query: `SELECT provider_id, toString(${clickHouseActivityCalendarDate("activity")}) AS activity_date
        FROM (SELECT 'mountain-project' AS provider_id, toDateTime64('2026-09-26 00:00:00', 6, 'UTC') AS started_at, 'unknown' AS local_time_source, CAST(NULL AS Nullable(Int32)) AS start_utc_offset_minutes
          UNION ALL SELECT 'kaya', toDateTime64('2026-09-26 00:00:00', 6, 'UTC'), 'unknown', CAST(NULL AS Nullable(Int32))
          UNION ALL SELECT 'kaya', toDateTime64('2026-09-26 18:00:00', 6, 'UTC'), 'unknown', CAST(NULL AS Nullable(Int32))
          UNION ALL SELECT 'kaya', toDateTime64('2026-09-26 06:00:00', 6, 'UTC'), 'provider_timezone', CAST(120 AS Nullable(Int32))) AS activity`,
      query_params: { timezone: "America/Los_Angeles" },
      format: "JSONEachRow",
    });
    const expected = [
      { provider_id: "mountain-project", activity_date: "2026-09-26" },
      { provider_id: "kaya", activity_date: "2026-09-25" },
      { provider_id: "kaya", activity_date: "2026-09-26" },
      { provider_id: "kaya", activity_date: "2026-09-26" },
    ];
    const parsedPgRows = z.array(activityDateRowSchema).parse(pgRows);
    const parsedClickHouseRows = z.array(activityDateRowSchema).parse(await chResult.json());
    expect(parsedPgRows).toEqual(expect.arrayContaining(expected));
    expect(parsedClickHouseRows).toEqual(expect.arrayContaining(expected));
  } finally {
    await clickhouse.close();
    await postgres.cleanup();
  }
});
