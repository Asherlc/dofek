import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ClickHouseClient,
  createClickHouseClientFromEnv,
} from "../../../../src/db/clickhouse.ts";
import { buildTestDailyActivityLoadSelectSql } from "./clickhouse-integration-test-read-models-b.ts";

const activityLoadRowsSchema = z.array(
  z.object({
    activity_id: z.string().uuid(),
    daily_load: z.coerce.number(),
  }),
);

describe("ClickHouse integration daily activity load test model", () => {
  const analyticsDatabase = `analytics_activity_load_${randomUUID().replaceAll("-", "")}`;
  const completedActivityId = randomUUID();
  const openActivityId = randomUUID();
  const userId = randomUUID();
  let client: ClickHouseClient;

  beforeAll(async () => {
    client = createClickHouseClientFromEnv();
    await client.command({ query: `CREATE DATABASE ${analyticsDatabase}` });
    await client.command({
      query: `CREATE TABLE ${analyticsDatabase}.activity_summary (
        activity_id UUID,
        user_id UUID,
        started_at DateTime64(6, 'UTC'),
        ended_at Nullable(DateTime64(6, 'UTC')),
        avg_hr Nullable(Float64),
        max_hr Nullable(Int16)
      ) ENGINE = MergeTree
      ORDER BY (user_id, activity_id)`,
    });
    await client.command({
      query: `INSERT INTO ${analyticsDatabase}.activity_summary VALUES
        (
          {completedActivityId:UUID},
          {userId:UUID},
          toDateTime64('2026-07-28 12:00:00', 6, 'UTC'),
          toDateTime64('2026-07-28 13:00:00', 6, 'UTC'),
          100,
          200
        ),
        (
          {openActivityId:UUID},
          {userId:UUID},
          toDateTime64('2026-07-28 14:00:00', 6, 'UTC'),
          NULL,
          100,
          200
        )`,
      query_params: { completedActivityId, openActivityId, userId },
    });
  });

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${analyticsDatabase}` });
    await client?.close?.();
  });

  it("excludes open activities instead of deriving load from the DateTime default", async () => {
    const result = await client.query({
      query: buildTestDailyActivityLoadSelectSql({
        analytics: analyticsDatabase,
        ingest: analyticsDatabase,
        postgresFitness: analyticsDatabase,
      }),
      format: "JSONEachRow",
    });

    expect(activityLoadRowsSchema.parse(await result.json())).toEqual([
      {
        activity_id: completedActivityId,
        daily_load: 30,
      },
    ]);
  });
});
