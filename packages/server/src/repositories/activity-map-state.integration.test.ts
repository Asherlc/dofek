import { randomUUID } from "node:crypto";
import { createClickHouseClientFromEnv } from "dofek/db/clickhouse";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigration } from "../../../../src/db/clickhouse-migrations/0086_activity_location_member_change.ts";
import { buildPostgresFitnessActivityRawTableStatement } from "../../../../src/db/clickhouse-raw-tables.ts";
import { persistClimbingLogEntries } from "../../../../src/db/climbing-log-sync.ts";
import { activity } from "../../../../src/db/schema/activity.ts";
import { TEST_USER_ID as userId } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import { buildTestAnalyticsTableStatement } from "../routers/clickhouse-integration-test-models.ts";
import { ActivitiesCalendarRepository } from "./activities-calendar-repository.ts";
import { ActivityRepository } from "./activity-repository.ts";
import { ClickHouseActivitySensorStore } from "./clickhouse-activity-sensor-store.ts";

describe("activity map readiness", () => {
  const database = `activity_map_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();
  const rewrite = (query: string) =>
    query.replaceAll("analytics.", `${database}.`).replaceAll("postgres_fitness.", `${database}.`);
  const sensorStore = new ClickHouseActivitySensorStore({
    query: (options) => client.query({ ...options, query: rewrite(options.query) }),
    command: (options) => client.command({ ...options, query: rewrite(options.query) }),
  });
  let context: TestContext;
  let calendar: ActivitiesCalendarRepository;
  let pendingGroup: string;
  let readyGroup: string;
  let unknownGroup: string;
  let absentId: string;
  let absentGroup: string;
  let sourceGroup: string;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await ensureProvider(context.db, "map-test", "Map test", undefined, userId);
    const rows = await context.db
      .insert(activity)
      .values(
        ["pending", "ready", "unknown", "absent", "source"].map((name, index) => ({
          userId,
          providerId: "map-test",
          externalId: name,
          name,
          canonicalType: name === "source" ? ("climbing" as const) : ("running" as const),
          providerType: name === "source" ? "climbing" : "running",
          startedAt: new Date(`2026-10-02T${12 + index}:00:00Z`),
          endedAt: new Date(`2026-10-02T${12 + index}:30:00Z`),
          providerAbsentAt: name === "absent" ? new Date("2026-10-03T00:00:00Z") : null,
        })),
      )
      .returning();
    const pending = rows.find((row) => row.name === "pending");
    const ready = rows.find((row) => row.name === "ready");
    const unknown = rows.find((row) => row.name === "unknown");
    const absent = rows.find((row) => row.name === "absent");
    const source = rows.find((row) => row.name === "source");
    if (
      !pending?.groupId ||
      !ready?.groupId ||
      !unknown?.groupId ||
      !absent?.groupId ||
      !source?.groupId
    )
      throw new Error("Expected map test activity groups");
    pendingGroup = pending.groupId;
    readyGroup = ready.groupId;
    unknownGroup = unknown.groupId;
    absentId = absent.id;
    absentGroup = absent.groupId;
    sourceGroup = source.groupId;
    await persistClimbingLogEntries(context.db, {
      userId,
      providerId: "map-test",
      entries: [
        {
          externalId: "source-log",
          activityId: source.id,
          attempts: [{ scope: "climb" }],
          climb: {
            externalId: "source-climb",
            kind: "route",
            coordinates: { latitude: 40.007, longitude: -105.4 },
          },
        },
      ],
    });
    await client.command({ query: `CREATE DATABASE ${database}` });
    const memberChangeTable = createMigration().statements[0];
    if (!memberChangeTable) throw new Error("Expected current location-change schema");
    for (const query of [
      buildTestAnalyticsTableStatement("analytics.deduped_activities"),
      buildTestAnalyticsTableStatement("analytics.activity_summary"),
      buildPostgresFitnessActivityRawTableStatement(),
      memberChangeTable,
      `CREATE TABLE analytics.user_profile_current
       (id UUID,max_hr Nullable(Float64),resting_hr Nullable(Float64),ftp Nullable(Float64)) ENGINE=Memory`,
      `CREATE TABLE analytics.activity_summary_rows
       (activity_id UUID,user_id UUID,avg_hr Nullable(Float64),max_hr Nullable(Float64),
        avg_power Nullable(Float64),total_distance Nullable(Float64),elevation_gain_m Nullable(Float64),
        centroid_lat Nullable(Float64),centroid_lng Nullable(Float64),refresh_version UInt64)
       ENGINE=ReplacingMergeTree(refresh_version) ORDER BY (user_id,activity_id)`,
      `CREATE TABLE analytics.activity_location_sample
       (activity_id UUID,user_id UUID,recorded_at DateTime64(9,'UTC'),source_metric_stream_id UUID,
        lat Nullable(Float64),lng Nullable(Float64),is_deleted UInt8,source_refreshed_at DateTime64(9,'UTC'),refresh_version UInt64)
       ENGINE=ReplacingMergeTree(refresh_version) ORDER BY (user_id,activity_id,source_metric_stream_id)`,
    ])
      await client.command({ query: rewrite(query) });
    if (!client.insert) throw new Error("ClickHouse test client requires inserts");
    await client.insert({
      table: `${database}.deduped_activities`,
      format: "JSONEachRow",
      values: rows
        .filter((row) => row.name !== "absent")
        .map((row) => ({
          activity_id: row.groupId,
          user_id: userId,
          provider_id: "map-test",
          canonical_type: row.canonicalType,
          provider_type: row.providerType,
          local_time_source: "unknown",
          name: row.name,
          started_at: row.startedAt.toISOString(),
          ended_at: row.endedAt?.toISOString(),
          member_activity_ids: [row.id],
          refreshed_at: "2026-10-02 16:00:00",
          source_synced_at: "2026-10-02 16:00:00",
        })),
    });
    await client.insert({
      table: `${database}.activity`,
      format: "JSONEachRow",
      values: [
        {
          id: absent.id,
          group_id: absent.groupId,
          user_id: userId,
          provider_id: "map-test",
          canonical_type: "running",
          provider_type: "running",
          name: absent.name,
          started_at: absent.startedAt.toISOString(),
          ended_at: absent.endedAt?.toISOString(),
          provider_absent_at: "2026-10-03 00:00:00",
          local_time_source: "unknown",
        },
      ],
    });
    await client.insert({
      table: `${database}.activity_summary`,
      format: "JSONEachRow",
      values: [
        {
          activity_id: readyGroup,
          user_id: userId,
          centroid_lat: 37.8,
          centroid_lng: -122.4,
        },
      ],
    });
    await client.insert({
      table: `${database}.activity_location_member_change`,
      format: "JSONEachRow",
      values: [pending, ready, absent, source]
        .map((row) => ({
          member_activity_id: row.id,
          user_id: userId,
          changed_at: "2026-10-02 16:00:00",
          has_live_sample: 1,
        }))
        .concat([
          {
            member_activity_id: unknown.id,
            user_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            changed_at: "2026-10-02 16:00:00",
            has_live_sample: 1,
          },
        ]),
    });
    calendar = new ActivitiesCalendarRepository(context.db, userId, "UTC", sensorStore);
  });
  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close?.();
    await context.cleanup();
  });

  it("shows processing for ingested GPS until a map is ready and preserves ready and absent states", async () => {
    const days = await calendar.getWeekList({
      weeks: 1,
      endDate: "2026-10-02",
      includeProviderAbsent: true,
    });
    const entries = days.flatMap((day) => day.activities);
    expect(entries.find((entry) => entry.id === pendingGroup)?.location).toEqual({
      kind: "processing",
    });
    expect(entries.find((entry) => entry.id === absentId)?.location).toEqual({
      kind: "processing",
    });
    expect(entries.find((entry) => entry.id === readyGroup)?.location).toMatchObject({
      kind: "recorded_gps",
    });
    expect(entries.find((entry) => entry.id === unknownGroup)?.location).toBeNull();
    expect(entries.find((entry) => entry.id === sourceGroup)?.location?.kind).toBe(
      "climbing_source",
    );
  });
  it("uses the canonical location contract in the recent activity list", async () => {
    const result = await new ActivityRepository(
      context.db,
      userId,
      "UTC",
      undefined,
      sensorStore,
    ).list({
      days: 1,
      endDate: "2026-10-02",
      limit: 20,
      offset: 0,
    });
    expect(result.items.find((entry) => entry.id === pendingGroup)?.location).toEqual({
      kind: "processing",
    });
    expect(result.items.find((entry) => entry.id === readyGroup)?.location).toMatchObject({
      kind: "recorded_gps",
    });
    expect(result.items.find((entry) => entry.id === unknownGroup)?.location).toBeNull();
  });
  it("finishes processing when the route model confirms that no GPS points remain", async () => {
    await client.command({
      query: `INSERT INTO ${database}.activity_location_sample
      (activity_id,user_id,source_metric_stream_id,is_deleted,source_refreshed_at)
      VALUES ('${pendingGroup}','${userId}','55555555-5555-5555-5555-555555555555',1,'2026-10-02 16:00:00')`,
    });
    const days = await calendar.getWeekList({ weeks: 1, endDate: "2026-10-02" });
    expect(
      days.flatMap((day) => day.activities).find((entry) => entry.id === pendingGroup)?.location,
    ).toBeNull();
  });
  it("shows processing when fresh GPS waits for its summary centroid", async () => {
    await client.command({
      query: `INSERT INTO ${database}.activity_location_sample
      (activity_id,user_id,source_metric_stream_id,lat,lng,source_refreshed_at)
      VALUES ('${unknownGroup}','${userId}','66666666-6666-6666-6666-666666666666',37.8,-122.4,'2026-10-02 16:00:00')`,
    });
    const days = await calendar.getWeekList({ weeks: 1, endDate: "2026-10-02" });
    expect(
      days.flatMap((day) => day.activities).find((entry) => entry.id === unknownGroup)?.location,
    ).toEqual({ kind: "processing" });
  });
  it("finishes processing provider-absent maps using their canonical route checkpoint", async () => {
    await client.command({
      query: `INSERT INTO ${database}.activity_location_sample
      (activity_id,user_id,source_metric_stream_id,is_deleted,source_refreshed_at)
      VALUES ('${absentGroup}','${userId}','77777777-7777-7777-7777-777777777777',1,'2026-10-02 16:00:00')`,
    });
    const days = await calendar.getWeekList({
      weeks: 1,
      endDate: "2026-10-02",
      includeProviderAbsent: true,
    });
    expect(
      days.flatMap((day) => day.activities).find((entry) => entry.id === absentId)?.location,
    ).toBeNull();
  });
  it("settles provider-absent source maps when the canonical route retains another source's GPS", async () => {
    await client.command({
      query: `INSERT INTO ${database}.activity_location_sample
      (activity_id,user_id,source_metric_stream_id,lat,lng,source_refreshed_at)
      VALUES ('${absentGroup}','${userId}','88888888-8888-8888-8888-888888888888',37.8,-122.4,'2026-10-02 16:00:00')`,
    });
    const days = await calendar.getWeekList({
      weeks: 1,
      endDate: "2026-10-02",
      includeProviderAbsent: true,
    });
    expect(
      days.flatMap((day) => day.activities).find((entry) => entry.id === absentId)?.location,
    ).toBeNull();
  });
});
