import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import {
  buildActivitySummaryRowsTableSql,
  buildActivitySummaryViewSql,
} from "../../../../src/db/clickhouse-activity-summary.ts";
import { cyclingPowerSchemaStatements } from "../../../../src/db/cycling-power-schema.ts";
import { activity } from "../../../../src/db/schema/activity.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import { ClickHouseActivitySensorStore } from "./clickhouse-activity-sensor-store.ts";
import { CyclingAdvancedRepository } from "./cycling-advanced-repository.ts";

describe("cycling variability canonical windows and pagination", () => {
  const client = createClickHouseClientFromEnv();
  const database = `variability_${randomUUID().replaceAll("-", "")}`;
  const rewrite = (query: string) => query.replaceAll("analytics.", `${database}.`);
  let context: TestContext;
  beforeAll(async () => {
    context = await setupTestDatabase();
    await client.command({ query: `CREATE DATABASE ${database}` });
    for (const query of [
      buildActivitySummaryRowsTableSql(),
      ...cyclingPowerSchemaStatements(),
      buildActivitySummaryViewSql(),
    ])
      await client.command({ query: rewrite(query) });
  });
  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close?.();
    await context?.cleanup();
  });
  async function fixture(rows: { daysAgo: number; np: number | null; eftp: number | null }[]) {
    const userId = randomUUID();
    const providerId = `variability-${userId}`;
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile(id,name) VALUES (${userId},'Variability fixture')`,
    );
    await ensureProvider(context.db, providerId, "Variability fixture", undefined, userId);
    const events: string[] = [];
    const ids: string[] = [];
    for (const row of rows) {
      const id = randomUUID();
      ids.push(id);
      const startedAt = new Date(Date.now() - row.daysAgo * 86400000);
      await context.db.insert(activity).values({
        id,
        groupId: id,
        userId,
        providerId,
        externalId: id,
        canonicalType: "cycling",
        providerType: "cycling",
        startedAt,
        endedAt: new Date(startedAt.getTime() + 3600000),
      });
      const timestamp = startedAt.toISOString().replace("T", " ").replace("Z", "");
      await client.command({
        query: `INSERT INTO ${database}.activity_summary_rows (activity_id,user_id,canonical_type,name,started_at,ended_at,smoothed_avg_power,refresh_version,is_deleted,refreshed_at) VALUES ('${id}','${userId}','cycling','Ride','${timestamp}','${timestamp}',200,1,0,now64(9))`,
      });
      await client.command({
        query: `INSERT INTO ${database}.cycling_power_observation_rows VALUES ('${userId}','${id}',${row.np ?? "NULL"},1,'np-v1',0,100,now64(6))`,
      });
      events.push(
        `(${startedAt.getTime() / 1000},'${id}',${row.eftp ?? "NULL"},${row.eftp === null || row.np === null ? "NULL" : row.np / row.eftp},NULL,NULL,0.0,0.0,0.0)`,
      );
    }
    await client.command({
      query: `INSERT INTO ${database}.cycling_power_history_rows VALUES ('${userId}',1,today(),'model-v1',[${events.join(",")}],200,now64(6))`,
    });
    const store = new ClickHouseActivitySensorStore({
      command: (options) => client.command({ ...options, query: rewrite(options.query) }),
      query: (options) => client.query({ ...options, query: rewrite(options.query) }),
    });
    return { ids, repo: new CyclingAdvancedRepository(context.db, userId, "UTC", store) };
  }
  it("applies finite and unbounded windows to rows and out-of-page totals", async () => {
    const { repo, ids } = await fixture([
      { daysAgo: 1, np: 220, eftp: 250 },
      { daysAgo: 120, np: 210, eftp: 250 },
    ]);
    expect(
      (await repo.getActivityVariability(30, 20, 0)).models.map((row) => row.activityId),
    ).toEqual([ids[0]]);
    expect(await repo.getActivityVariability(30, 20, 10)).toMatchObject({
      models: [],
      totalCount: 1,
      emptyReason: null,
    });
    expect((await repo.getActivityVariability(null, 20, 0)).models).toHaveLength(2);
    expect(await repo.getActivityVariability(null, 20, 10)).toMatchObject({
      models: [],
      totalCount: 2,
      emptyReason: null,
    });
  });
  it("distinguishes missing normalized power from unavailable threshold evidence", async () => {
    const missing = await fixture([{ daysAgo: 1, np: null, eftp: null }]);
    expect(await missing.repo.getActivityVariability(30, 20, 0)).toMatchObject({
      models: [],
      totalCount: 0,
      emptyReason: "no_normalized_power",
    });
    const unsupported = await fixture([{ daysAgo: 1, np: 220, eftp: null }]);
    expect(await unsupported.repo.getActivityVariability(30, 20, 0)).toMatchObject({
      models: [],
      totalCount: 0,
      emptyReason: "no_ftp_estimate",
    });
  });
});
