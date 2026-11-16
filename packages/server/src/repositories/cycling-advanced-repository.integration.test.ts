import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import {
  buildActivitySummaryRowsTableSql,
  buildActivitySummaryViewSql,
} from "../../../../src/db/clickhouse-activity-summary.ts";
import { dedupedActivitiesTableSql } from "../../../../src/db/clickhouse-migrations/0024_create_dbt_serving_read_model_tables.ts";
import { cyclingPowerSchemaStatements } from "../../../../src/db/cycling-power-schema.ts";
import { activity } from "../../../../src/db/schema/activity.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import { buildAccountErasureFenceTableSql } from "../../../../src/metric-stream/clickhouse-table.ts";
import { ClickHouseActivitySensorStore } from "./clickhouse-activity-sensor-store.ts";
import { CyclingAdvancedRepository } from "./cycling-advanced-repository.ts";
import { CyclingThresholdRepository } from "./cycling-threshold-repository.ts";

describe("cycling variability canonical windows and pagination", () => {
  const client = createClickHouseClientFromEnv();
  const database = `variability_${randomUUID().replaceAll("-", "")}`;
  const rewrite = (query: string) =>
    query.replaceAll("analytics.", `${database}.`).replaceAll("ingest.", `${database}.`);
  let context: TestContext;
  beforeAll(async () => {
    context = await setupTestDatabase();
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({ query: rewrite(buildAccountErasureFenceTableSql()) });
    for (const query of [
      buildActivitySummaryRowsTableSql(),
      ...cyclingPowerSchemaStatements(),
      dedupedActivitiesTableSql,
      buildActivitySummaryViewSql(),
    ])
      await client.command({ query: rewrite(query) });
  });
  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close?.();
    await context?.cleanup();
  });
  afterEach(() => vi.restoreAllMocks());
  async function fixture(rows: { daysAgo: number; np: number | null; ftp: number | null }[]) {
    const userId = randomUUID();
    const providerId = `variability-${userId}`;
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile(id,name) VALUES (${userId},'Variability fixture')`,
    );
    await ensureProvider(context.db, providerId, "Variability fixture", undefined, userId);
    if (rows.some((row) => row.ftp !== null)) {
      await context.db.execute(sql`INSERT INTO fitness.sport_settings
        (user_id, sport, ftp, effective_from) VALUES (${userId}::uuid, 'cycling',
        ${rows.find((row) => row.ftp !== null)?.ftp ?? null}, CURRENT_DATE - 365)`);
    }
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
        query: `INSERT INTO ${database}.deduped_activities
          (activity_id,provider_id,user_id,activity_type,started_at,ended_at,start_utc_offset_minutes,local_time_source,
           source_synced_at,source_providers,source_external_ids,absent_source_external_ids,member_activity_ids,
           refresh_version,is_deleted,refreshed_at)
          VALUES ('${id}','${providerId}','${userId}','cycling','${timestamp}','${timestamp}',NULL,'unknown',
            now64(9),['fixture'],[],[],['${id}'],1,0,now64(9))`,
      });
    }
    await client.command({
      query: `INSERT INTO ${database}.cycling_power_observation_rows (user_id,activity_id,normalized_power,source_refresh_version,model_version,is_deleted,refresh_version,refreshed_at) VALUES ${rows
        .map(
          (row, index) =>
            `('${userId}','${ids[index]}',${row.np ?? "NULL"},1,'np-v1',0,1,now64(6))`,
        )
        .join(",")}`,
    });
    const store = new ClickHouseActivitySensorStore({
      command: (options) => client.command({ ...options, query: rewrite(options.query) }),
      query: (options) => client.query({ ...options, query: rewrite(options.query) }),
    });
    return { ids, repo: new CyclingAdvancedRepository(context.db, userId, "UTC", store) };
  }
  it("applies finite and unbounded windows to rows and out-of-page totals", async () => {
    const { repo, ids } = await fixture([
      { daysAgo: 1, np: 220, ftp: 250 },
      { daysAgo: 120, np: 210, ftp: 250 },
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
    const missing = await fixture([{ daysAgo: 1, np: null, ftp: null }]);
    expect(await missing.repo.getActivityVariability(30, 20, 0)).toMatchObject({
      models: [],
      totalCount: 0,
      emptyReason: "no_normalized_power",
    });
    const unsupported = await fixture([{ daysAgo: 1, np: 220, ftp: null }]);
    expect(await unsupported.repo.getActivityVariability(30, 20, 0)).toMatchObject({
      models: [],
      totalCount: 0,
      emptyReason: "no_configured_ftp",
    });
  });

  it("filters source-local FTP intervals before paging and resolves only page IDs", async () => {
    const userId = randomUUID();
    const providerId = `variability-history-${userId}`;
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile(id,name) VALUES (${userId},'Variability history fixture')`,
    );
    await ensureProvider(context.db, providerId, "Variability history fixture", undefined, userId);
    await context.db.execute(sql`INSERT INTO fitness.sport_settings
      (user_id, sport, ftp, effective_from) VALUES
      (${userId}::uuid, 'cycling', 250, '2026-05-01'),
      (${userId}::uuid, 'cycling', NULL, '2026-06-01'),
      (${userId}::uuid, 'cycling', 275, '2026-06-15'),
      (${userId}::uuid, 'cycling', 300, '2026-07-01')`);

    const rides = [
      { date: "2026-05-20T12:00:00Z", np: 200, offset: null, source: "unknown" },
      { date: "2026-06-10T12:00:00Z", np: 210, offset: null, source: "unknown" },
      { date: "2026-06-14T23:30:00Z", np: 220, offset: 120, source: "provider_offset" },
      { date: "2026-06-20T12:00:00Z", np: 0, offset: null, source: "unknown" },
    ];
    const ids: string[] = [];
    for (const [index, ride] of rides.entries()) {
      const id = randomUUID();
      ids.push(id);
      const startedAt = new Date(ride.date);
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
        startUtcOffsetMinutes: ride.offset,
        localTimeSource: ride.source,
      });
      const timestamp = startedAt.toISOString().replace("T", " ").replace("Z", "");
      await client.command({
        query: `INSERT INTO ${database}.activity_summary_rows
          (activity_id,user_id,canonical_type,name,started_at,ended_at,smoothed_avg_power,refresh_version,is_deleted,refreshed_at)
          VALUES ('${id}','${userId}','cycling','Ride ${index}','${timestamp}','${timestamp}',200,1,0,now64(9))`,
      });
      await client.command({
        query: `INSERT INTO ${database}.deduped_activities
          (activity_id,provider_id,user_id,activity_type,started_at,ended_at,start_utc_offset_minutes,local_time_source,
           source_synced_at,source_providers,source_external_ids,absent_source_external_ids,member_activity_ids,
           refresh_version,is_deleted,refreshed_at)
          VALUES ('${id}','${providerId}','${userId}','cycling','${timestamp}','${timestamp}',${ride.offset ?? "NULL"},
            '${ride.source}',now64(9),['fixture'],[],[],['${id}'],1,0,now64(9))`,
      });
      await client.command({
        query: `INSERT INTO ${database}.cycling_power_observation_rows
          (user_id,activity_id,normalized_power,source_refresh_version,model_version,is_deleted,refresh_version,refreshed_at)
          VALUES ('${userId}','${id}',${ride.np},1,'np-v1',0,1,now64(6))`,
      });
    }
    const store = new ClickHouseActivitySensorStore({
      command: (options) => client.command({ ...options, query: rewrite(options.query) }),
      query: (options) => client.query({ ...options, query: rewrite(options.query) }),
    });
    const resolver = vi.spyOn(CyclingThresholdRepository.prototype, "getForActivities");
    const repo = new CyclingAdvancedRepository(context.db, userId, "America/Los_Angeles", store);

    const page = await repo.getActivityVariability(null, 1, 0);
    expect(page.totalCount).toBe(3);
    expect(page.models.map((model) => model.activityId)).toEqual([ids[3]]);
    expect(page.models[0]?.normalizedPower).toBe(0);
    expect(resolver.mock.calls[0]?.[0]).toEqual([ids[3]]);
    expect(page.models[0]?.date).toBe("2026-06-20");

    const sourceLocalPage = await repo.getActivityVariability(null, 1, 1);
    expect(sourceLocalPage.models.map((model) => model.activityId)).toEqual([ids[2]]);
    expect(sourceLocalPage.models[0]?.date).toBe("2026-06-14");
    expect(resolver.mock.calls[1]?.[0]).toEqual([ids[2]]);

    const pastEnd = await repo.getActivityVariability(null, 1, 10);
    expect(pastEnd).toMatchObject({ models: [], totalCount: 3, emptyReason: null });
    expect(resolver.mock.calls[2]?.[0]).toEqual([]);
  });
});
