import { randomUUID } from "node:crypto";
import { formatDateTime } from "@dofek/format/format";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import { buildActivitySummaryRowsTableSql } from "../../../../src/db/clickhouse-activity-summary.ts";
import { persistClimbingLogEntries } from "../../../../src/db/climbing-log-sync.ts";
import { activity } from "../../../../src/db/schema/activity.ts";
import { TEST_USER_ID as userId } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import { osmTilePreview } from "../lib/osm-tile.ts";
import {
  createClickHouseTestActivitySensorStore,
  executeClickHouseTestCommand,
} from "../routers/clickhouse-integration-test-helpers.ts";
import { buildTestAnalyticsTableStatement } from "../routers/clickhouse-integration-test-models.ts";
import { ActivitiesCalendarRepository } from "./activities-calendar-repository.ts";
import { ClickHouseActivitySensorStore } from "./clickhouse-activity-sensor-store.ts";
import { ClimbingActivityLogEntryRepository } from "./climbing-activity-log-entry-repository.ts";

describe("Activities list source tree hydration", () => {
  let context: TestContext;
  let repository: ActivitiesCalendarRepository;
  const groupId = randomUUID();
  const ids = Array.from({ length: 5 }, () => randomUUID());
  const absentId = randomUUID();
  beforeAll(async () => {
    context = await setupTestDatabase();
    const providers = ["wahoo", "strava", "strava", "apple_health", "garmin"];
    for (const provider of new Set(providers)) {
      await ensureProvider(context.db, provider, provider, undefined, userId);
    }
    await context.db.insert(activity).values(
      providers.map((providerId, index) => ({
        id: ids[index],
        groupId,
        userId,
        providerId,
        externalId: `source-tree-${index}`,
        canonicalType: "cycling" as const,
        providerType: "cycling",
        startedAt: new Date("2026-10-02T12:00:00Z"),
        endedAt: new Date("2026-10-02T12:30:00Z"),
      })),
    );
    const client = createClickHouseClientFromEnv();
    const database = `source_tree_test_${randomUUID().replaceAll("-", "")}`;
    const rewrite = (query: string) => query.replace(/\b(analytics|postgres_fitness)\b/g, database);
    context.addCleanup(async () => {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
      await client.close?.();
    });
    await client.command({ query: `CREATE DATABASE ${database}` });
    for (const table of ["deduped_activities", "activity_summary", "activity_location_sample"]) {
      await client.command({
        query: rewrite(buildTestAnalyticsTableStatement(`analytics.${table}`)),
      });
    }
    await client.command({ query: rewrite(buildActivitySummaryRowsTableSql()) });
    await client.command({
      query: `CREATE TABLE ${database}.activity
      (id UUID, group_id UUID, user_id UUID, provider_id String, external_id String,
       name Nullable(String), canonical_type String, modality Nullable(String),
       started_at DateTime64(6, 'UTC'), ended_at Nullable(DateTime64(6, 'UTC')),
       source_name Nullable(String), timezone Nullable(String), start_utc_offset_minutes Nullable(Int16),
       end_utc_offset_minutes Nullable(Int16), local_time_source String,
       provider_absent_at Nullable(DateTime64(6, 'UTC')), _peerdb_is_deleted UInt8)
      ENGINE=ReplacingMergeTree ORDER BY (user_id, id)`,
    });
    await client.command({
      query: `INSERT INTO ${database}.activity
      (id,group_id,user_id,provider_id,external_id,canonical_type,started_at,ended_at,source_name,local_time_source,provider_absent_at)
      VALUES ('${absentId}','${absentId}','${userId}','strava','removed-source-tree','cycling',
        '2026-10-02 12:00:00','2026-10-02 12:30:00','Garmin Edge 530','unknown','2026-10-03 12:00:00')`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.user_profile_current
      (id UUID, max_hr Nullable(Int32), resting_hr Nullable(Int32), ftp Nullable(Float64)) ENGINE=Memory`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.activity_location_member_change
      (user_id UUID, member_activity_id UUID, changed_at DateTime64(9, 'UTC')) ENGINE=Memory`,
    });
    const sourceMaps = providers
      .map(
        (provider, index) =>
          `map('providerId','${provider}','externalId','source-tree-${index}','memberActivityId','${ids[index]}')`,
      )
      .join(",");
    const evidence = [
      [0, 1],
      [1, 2],
      [0, 3],
    ]
      .map(
        ([upstream, downstream]) =>
          `map('upstreamMemberActivityId','${ids[upstream ?? 0]}','downstreamMemberActivityId','${ids[downstream ?? 0]}','field','external_id','value','fixture-reference')`,
      )
      .join(",");
    await client.command({
      query: `INSERT INTO ${database}.deduped_activities
      (activity_id, user_id, provider_id, canonical_type, provider_type, started_at, ended_at,
       local_time_source, primary_activity_id, primary_provider_id, member_activity_ids,
       source_external_ids, origin_evidence, refreshed_at)
      VALUES ('${groupId}','${userId}','wahoo','cycling','cycling','2026-10-02 12:00:00','2026-10-02 12:30:00',
        'unknown','${ids[0]}','wahoo',[${ids.map((id) => `'${id}'`).join(",")}],
        [${sourceMaps}],[${evidence}],'2026-10-02 12:35:00')`,
    });
    const sensorStore = new ClickHouseActivitySensorStore({
      command: (options) => client.command({ ...options, query: rewrite(options.query) }),
      query: (options) => client.query({ ...options, query: rewrite(options.query) }),
    });
    repository = new ActivitiesCalendarRepository(context.db, userId, "UTC", sensorStore);
  });
  afterAll(async () => {
    await context.cleanup();
  });
  it("hydrates stored evidence branches, duplicate provider records, and disconnected sources", async () => {
    const entries = (await repository.getWeekList({ weeks: 1, endDate: "2026-10-02" })).flatMap(
      (day) => day.activities,
    );
    const entry = entries.find((candidate) => candidate.id === groupId);
    expect(entry?.source.tree).toMatchObject({
      primary: {
        id: ids[0],
        children: [
          {
            id: ids[3],
            providerId: "apple_health",
            description: "Imported from Wahoo",
            children: [],
          },
          { id: ids[1], providerId: "strava", children: [{ id: ids[2], providerId: "strava" }] },
        ],
      },
      otherSources: [{ id: ids[4], providerId: "garmin", description: null }],
    });
  });
  it("hydrates removed-record identity and recording-device attribution", async () => {
    const entries = (
      await repository.getWeekList({ weeks: 1, endDate: "2026-10-02", includeProviderAbsent: true })
    ).flatMap((day) => day.activities);
    expect(entries.find((entry) => entry.id === absentId)?.source.tree).toMatchObject({
      primary: {
        label: "Garmin Edge 530",
        description: null,
        children: [
          {
            id: absentId,
            providerId: "strava",
            label: "Strava",
            description: `Removed from provider ${formatDateTime("2026-10-03 12:00:00")}`,
            url: null,
          },
        ],
      },
      otherSources: [],
    });
  });
});

describe("Activities list climbing source GPS", () => {
  let context: TestContext;
  let repository: ActivitiesCalendarRepository;
  let sourceGroup: string;
  let recordedGroup: string;
  let unknownGroup: string;
  let sourceActivityId: string;
  beforeAll(async () => {
    context = await setupTestDatabase();
    await ensureProvider(context.db, "openbeta", "OpenBeta", undefined, userId);
    const rows = await context.db
      .insert(activity)
      .values(
        ["source", "recorded", "unknown"].map((name, index) => ({
          userId,
          providerId: "openbeta",
          externalId: name,
          name,
          canonicalType: "climbing" as const,
          providerType: "rock-climbing",
          startedAt: new Date(`2026-10-02T${12 + index}:00:00Z`),
          endedAt: new Date(`2026-10-02T${12 + index}:30:00Z`),
        })),
      )
      .returning();
    const source = rows.find((row) => row.name === "source");
    const recorded = rows.find((row) => row.name === "recorded");
    const unknown = rows.find((row) => row.name === "unknown");
    if (!source?.groupId || !recorded?.groupId || !unknown?.groupId)
      throw new Error("Expected activity groups");
    sourceGroup = source.groupId;
    sourceActivityId = source.id;
    recordedGroup = recorded.groupId;
    unknownGroup = unknown.groupId;
    await persistClimbingLogEntries(context.db, {
      userId,
      providerId: "openbeta",
      entries: [
        {
          externalId: "source-log",
          activityId: source.id,
          attempts: [{ scope: "climb", ropeMethod: "lead" }],
          climb: {
            externalId: "area-route",
            name: "Area route",
            kind: "route",
            areas: [
              {
                externalId: "boulder-canyon",
                name: "Boulder Canyon",
                coordinates: { latitude: 40.007, longitude: -105.4 },
              },
            ],
          },
        },
        {
          externalId: "recorded-log",
          activityId: recorded.id,
          attempts: [{ scope: "climb", ropeMethod: "lead" }],
          climb: {
            externalId: "exact-route",
            name: "Exact route",
            kind: "route",
            coordinates: { latitude: 40.007, longitude: -105.4 },
          },
        },
      ],
    });
    const sensorStore = await createClickHouseTestActivitySensorStore(context);
    await executeClickHouseTestCommand(
      context,
      `ALTER TABLE analytics.activity_summary UPDATE centroid_lat=37.8,centroid_lng=-122.4
       WHERE activity_id=toUUID('${recorded.groupId}') AND user_id=toUUID('${userId}')
       SETTINGS mutations_sync=2`,
    );
    repository = new ActivitiesCalendarRepository(context.db, userId, "UTC", sensorStore);
  });
  afterAll(async () => {
    await context.cleanup();
  });

  it("serves attached Area points through weekList while retaining recorded GPS and GPS-less activities", async () => {
    const days = await repository.getWeekList({ weeks: 1, endDate: "2026-10-02" });
    const entries = days.flatMap((day) => day.activities);
    expect(entries).toHaveLength(3);
    expect(entries.find((entry) => entry.id === sourceGroup)?.location).toMatchObject({
      kind: "climbing_source",
      mapPreview: { routePath: null },
      sourcePoints: [
        {
          x: 512,
          y: 288,
          location: {
            scope: "area",
            name: "Boulder Canyon",
            providerId: "openbeta",
            coordinates: { latitude: 40.007, longitude: -105.4 },
          },
        },
      ],
    });
    expect(entries.find((entry) => entry.id === recordedGroup)?.location).toEqual({
      kind: "recorded_gps",
      centroidLat: 37.8,
      centroidLng: -122.4,
      mapPreview: osmTilePreview([{ lat: 37.8, lng: -122.4 }]),
    });
    expect(entries.find((entry) => entry.id === unknownGroup)?.location).toBeNull();
  });
  it("uses the saved grade preference for the same consolidated source graphs as detail", async () => {
    await ensureProvider(context.db, "mountain-project", "Mountain Project", undefined, userId);
    const [member] = await context.db
      .insert(activity)
      .values({
        userId,
        providerId: "mountain-project",
        externalId: "preferred-member",
        groupId: sourceGroup,
        canonicalType: "climbing",
        providerType: "climbing",
        startedAt: new Date("2026-10-02T12:00:00Z"),
      })
      .onConflictDoUpdate({
        target: [activity.userId, activity.providerId, activity.externalId],
        set: { groupId: sourceGroup },
      })
      .returning();
    if (!member) throw new Error("Expected member");
    for (const { providerId, activityId, externalId, french } of [
      {
        providerId: "openbeta",
        activityId: sourceActivityId,
        externalId: "source-log",
        french: "6a",
      },
      {
        providerId: "mountain-project",
        activityId: member.id,
        externalId: "preferred-log",
        french: "6b",
      },
    ]) {
      await persistClimbingLogEntries(context.db, {
        userId,
        providerId,
        entries: [
          {
            externalId,
            activityId,
            attempts: [{ scope: "climb", ropeMethod: "lead" }],
            climb: {
              externalId: "area-route",
              name: "Area route",
              kind: "route",
              publishedGrades: [
                { value: "5.10a", system: "yds" },
                { value: french, system: "french" },
              ],
              areas: [
                {
                  externalId: "boulder-canyon",
                  name: "Boulder Canyon",
                  coordinates: { latitude: 40.007, longitude: -105.4 },
                },
              ],
            },
          },
        ],
      });
    }
    await context.db.execute(sql`INSERT INTO fitness.user_settings (user_id,key,value)
      VALUES (${userId}::uuid,'climbingGradeSystems','{"boulder":"v_scale","route":"french"}'::jsonb)
      ON CONFLICT (user_id,key) DO UPDATE SET value=EXCLUDED.value`);
    const details = (
      await new ClimbingActivityLogEntryRepository(context.db, userId, "UTC", undefined, {
        boulder: "v_scale",
        route: "french",
      }).getActivityLogEntries(sourceGroup)
    ).map((entry) => entry.toDetail());
    expect(details).toHaveLength(2);
    const days = await repository.getWeekList({ weeks: 1, endDate: "2026-10-02" });
    const location = days
      .flatMap((day) => day.activities)
      .find((entry) => entry.id === sourceGroup)?.location;
    if (location?.kind !== "climbing_source") throw new Error("Expected climbing source thumbnail");
    expect(location.sourcePoints).toHaveLength(2);
    expect(location.sourcePoints.map((point) => point.location)).toEqual(
      expect.arrayContaining(details.map((entry) => entry.mapLocation)),
    );
  });
});

describe("Activities list cycling modality", () => {
  let context: TestContext;
  let repository: ActivitiesCalendarRepository;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await ensureProvider(context.db, "wahoo", "Wahoo", undefined, userId);
    await context.db.insert(activity).values(
      [false, true].flatMap((isProviderAbsent) =>
        (["indoor", "virtual", "road", null] as const).map((modality, index) => ({
          userId,
          providerId: "wahoo",
          externalId: `cycling-${modality}-${isProviderAbsent}`,
          name: `cycling-${modality}-${isProviderAbsent}`,
          canonicalType: "cycling" as const,
          providerType: "cycling",
          modality,
          startedAt: new Date(`2026-10-02T${10 + index}:00:00Z`),
          endedAt: new Date(`2026-10-02T${10 + index}:30:00Z`),
          providerAbsentAt: isProviderAbsent ? new Date("2026-10-03T12:00:00Z") : null,
        })),
      ),
    );
    const sensorStore = await createClickHouseTestActivitySensorStore(context);
    repository = new ActivitiesCalendarRepository(context.db, userId, "UTC", sensorStore);
  });

  afterAll(async () => {
    await context.cleanup();
  });

  it("preserves stored cycling modality through active and provider-absent week lists", async () => {
    const activeDays = await repository.getWeekList({ weeks: 1, endDate: "2026-10-02" });
    const activeEntries = activeDays
      .flatMap((day) => day.activities)
      .filter((entry) => entry.activityType === "cycling");
    expect(activeEntries).toHaveLength(4);
    expect(activeEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "cycling-indoor-false", modality: "indoor" }),
        expect.objectContaining({ name: "cycling-virtual-false", modality: "virtual" }),
        expect.objectContaining({ name: "cycling-road-false", modality: "road" }),
        expect.objectContaining({ name: "cycling-null-false", modality: null }),
      ]),
    );

    const allDays = await repository.getWeekList({
      weeks: 1,
      endDate: "2026-10-02",
      includeProviderAbsent: true,
    });
    const absentEntries = allDays
      .flatMap((day) => day.activities)
      .filter((entry) => entry.activityType === "cycling" && entry.isProviderAbsent);
    expect(absentEntries).toHaveLength(4);
    expect(absentEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "cycling-indoor-true", modality: "indoor" }),
        expect.objectContaining({ name: "cycling-virtual-true", modality: "virtual" }),
        expect.objectContaining({ name: "cycling-road-true", modality: "road" }),
        expect.objectContaining({ name: "cycling-null-true", modality: null }),
      ]),
    );
  });
});
