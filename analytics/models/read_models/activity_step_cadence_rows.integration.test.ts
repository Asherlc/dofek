import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appleHealthWorkoutExternalId } from "../../../packages/server/src/routers/health-kit-sync-processors.ts";
import {
  type ClickHouseClient,
  createClickHouseClientFromEnv,
} from "../../../src/db/clickhouse.ts";
import { buildActivityStepCadenceRowsTableSql } from "../../../src/db/clickhouse-activity-step-cadence.ts";
import { buildActivitySummaryRowsTableSql } from "../../../src/db/clickhouse-activity-summary.ts";
import { buildActivitySensorSummaryRowsTableSql } from "../../../src/db/clickhouse-activity-sensor-summary.ts";
import { createActivitySourceRecordsSql } from "../../../src/db/activity-payload-dbt-source-test-helpers.ts";
import { readModelSql, renderDbtModelSql } from "../../../src/db/read-model-sql-test-helpers.ts";
import { buildIngestMetricStreamCreateTableSql } from "../../../src/metric-stream/clickhouse-table.ts";

const user = randomUUID();
const group = randomUUID();
const member = randomUUID();
const workout = randomUUID();
const database = `running_cadence_${randomUUID().replaceAll("-", "")}`;
let client: ClickHouseClient;
function render(name: string, scopedIds?: string[]) {
  return renderDbtModelSql(readModelSql(`${name}.sql`), {
    isIncremental: true,
    activityRefreshScoped: scopedIds !== undefined,
  })
    .replaceAll('{{ var("activity_refresh_user_id") }}', user)
    .replaceAll(
      "{{ activity_refresh_ids() }}",
      `CAST([${(scopedIds ?? []).map((id) => `'${id}'`).join(",")}], 'Array(UUID)')`,
    )
    .replaceAll("{{ initial_lookback_days }}", "10000")
    .replaceAll("{{ activity_step_cadence_batch_size }}", "100")
    .replaceAll("{{ this }}", `${database}.${name}`)
    .replace(/{{ ref\('([^']+)'\) }}/g, `${database}.$1`)
    .replace(/{{ source\('[^']+', '([^']+)'\) }}/g, `${database}.$1`)
    .concat("\nSETTINGS join_use_nulls = 1, max_threads = 1, enable_materialized_cte = 1");
}
async function run(name: string, scopedIds?: string[]) {
  await client.command({ query: `INSERT INTO ${database}.${name} ${render(name, scopedIds)}` });
}
async function rows(table: string, fields = "*") {
  const result = await client.query({
    query: `SELECT ${fields} FROM ${database}.${table} FINAL ORDER BY user_id, activity_id`,
    format: "JSONEachRow",
  });
  return result.json<Record<string, unknown>>();
}
async function insertValues(input: {
  table: string;
  format: "JSONEachRow";
  values: readonly object[];
}) {
  if (!client.insert) throw new Error("ClickHouse fixture client must support insert");
  await client.insert(input);
}
async function steps(
  start: string,
  end: string,
  count: number,
  options: {
    id?: string;
    bundle?: string;
    device?: string;
    uuids?: string[];
    deleted?: number;
    version?: number;
  } = {},
) {
  const id = options.id ?? randomUUID();
  await insertValues({
    table: `${database}.metric_stream_current`,
    format: "JSONEachRow",
    values: [
      {
        id,
        user_id: user,
        provider_id: "apple_health",
        recorded_at: `2026-10-01 ${start}`,
        channel: "step_count",
        external_id: `hk:${id}`,
        device_id: options.device ?? "Watch",
        scalar: count,
        metadata: JSON.stringify({
          interval_end: `2026-10-01T${end}Z`,
          source_bundle: options.bundle ?? "com.apple.watch",
          workout_uuids: options.uuids ?? [workout],
        }),
        version: options.version ?? 1,
        is_deleted: options.deleted ?? 0,
        ingested_at: `2026-10-02 00:00:0${options.version ?? 1}`,
      },
    ],
  });
  await client.command({
    query: `INSERT INTO ${database}.metric_stream_day_change VALUES ('${user}', 'apple_health', '2026-10-01', now64(9))`,
  });
  return id;
}
async function activities(
  records: { id: string; memberId: string; uuid: string; deleted?: number; owner?: string }[],
) {
  const refreshVersion = Date.now();
  const refreshedAt = new Date().toISOString();
  await insertValues({
    table: `${database}.deduped_activities`,
    format: "JSONEachRow",
    values: records.map((record) => ({
      activity_id: record.id,
      user_id: record.owner ?? user,
      canonical_type: "running",
      started_at: "2026-10-01 08:00:00",
      ended_at: "2026-10-01 08:10:00",
      member_activity_ids: [record.memberId],
      is_deleted: record.deleted ?? 0,
      refresh_version: refreshVersion,
      refreshed_at: refreshedAt,
    })),
  });
  await insertValues({
    table: `${database}.activity_source_records`,
    format: "JSONEachRow",
    values: records.map((record) => ({
      activity_id: record.memberId,
      group_id: record.id,
      user_id: record.owner ?? user,
      provider_id: "apple_health",
      external_id: appleHealthWorkoutExternalId(record.uuid),
      canonical_type: "running",
      started_at: "2026-10-01 08:00:00",
      ended_at: "2026-10-01 08:10:00",
      source_name: "Watch",
      is_deleted: record.deleted ?? 0,
      refresh_version: refreshVersion,
      source_synced_at: "2026-10-01 09:00:00",
      refreshed_at: refreshedAt,
    })),
  });
}
async function activity(id = group, memberId = member, uuid = workout, deleted = 0, owner = user) {
  await activities([{ id, memberId, uuid, deleted, owner }]);
}
async function seedBacklog() {
  await activities(
    Array.from({ length: 101 }, () => ({
      id: randomUUID(),
      memberId: randomUUID(),
      uuid: randomUUID(),
    })),
  );
  await run("activity_step_cadence_rows");
  expect(await rows("activity_step_cadence_rows")).toHaveLength(100);
  await run("activity_step_cadence_rows");
  expect(await rows("activity_step_cadence_rows")).toHaveLength(102);
}
describe("running step cadence read model", () => {
  beforeAll(async () => {
    client = createClickHouseClientFromEnv();
    const statements = [
      `CREATE DATABASE ${database}`,
      buildIngestMetricStreamCreateTableSql().replaceAll(
        "ingest.metric_stream",
        `${database}.metric_stream_current`,
      ),
      createActivitySourceRecordsSql(database),
      `CREATE TABLE ${database}.deduped_activities (activity_id UUID,user_id UUID,canonical_type String,provider_type Nullable(String),modality Nullable(String),name Nullable(String),started_at DateTime64(6,'UTC'),ended_at Nullable(DateTime64(6,'UTC')),member_activity_ids Array(UUID),is_deleted UInt8,refresh_version UInt64,refreshed_at DateTime64(9,'UTC')) ENGINE=ReplacingMergeTree(refresh_version) ORDER BY (user_id,activity_id)`,
      `CREATE TABLE ${database}.deduped_activity_members (activity_id UUID,user_id UUID,member_activity_id UUID,is_deleted UInt8) ENGINE=ReplacingMergeTree ORDER BY (user_id,member_activity_id)`,
      `CREATE TABLE ${database}.activity (group_id UUID,user_id UUID,started_at DateTime64(6,'UTC'),ended_at Nullable(DateTime64(6,'UTC')),_peerdb_synced_at DateTime64(9,'UTC')) ENGINE=MergeTree ORDER BY group_id`,
      `CREATE TABLE ${database}.metric_stream_day_change(user_id UUID,provider_id String,recorded_date Date,changed_at DateTime64(9,'UTC')) ENGINE=MergeTree ORDER BY (user_id,recorded_date)`,
      `CREATE TABLE ${database}.sensor_provider_priority(provider_id String,channel String,priority Int32,_peerdb_is_deleted UInt8,_peerdb_version UInt64) ENGINE=ReplacingMergeTree(_peerdb_version) ORDER BY (provider_id,channel)`,
      `CREATE TABLE ${database}.sensor_device_priority(provider_id String,channel String,source_name_pattern String,priority Int32,_peerdb_is_deleted UInt8,_peerdb_version UInt64) ENGINE=ReplacingMergeTree(_peerdb_version) ORDER BY (provider_id,channel,source_name_pattern)`,
      buildActivityStepCadenceRowsTableSql().replaceAll("analytics.", `${database}.`),
      buildActivitySummaryRowsTableSql().replaceAll("analytics.", `${database}.`),
      buildActivitySensorSummaryRowsTableSql().replaceAll("analytics.", `${database}.`),
      `CREATE TABLE ${database}.activity_location_summary_rows(activity_id UUID,user_id UUID,total_distance Nullable(Float64),centroid_lat Nullable(Float64),centroid_lng Nullable(Float64),refresh_version UInt64,is_deleted UInt8,refreshed_at DateTime64(9,'UTC')) ENGINE=ReplacingMergeTree(refresh_version) ORDER BY (user_id,activity_id)`,
    ];
    for (const query of statements) await client.command({ query });
  });
  beforeEach(async () => {
    for (const table of [
      "deduped_activities",
      "activity_source_records",
      "activity_summary_rows",
      "activity_step_cadence_rows",
      "metric_stream_current",
      "metric_stream_day_change",
      "sensor_device_priority",
      "sensor_provider_priority",
      "activity_sensor_summary_rows",
    ])
      await client.command({ query: `TRUNCATE TABLE ${database}.${table}` });
    await activity();
  });
  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client?.close();
  });
  it("joins production workout identities to raw UUID associations through the shared summary", async () => {
    await steps("08:00:00", "08:01:00", 150);
    await steps("08:01:00", "08:03:00", 450);
    await run("activity_step_cadence_rows");
    await run("activity_summary_rows");
    expect(
      await rows(
        "activity_summary_rows",
        "avg_cadence,cadence_basis,cadence_observed_seconds,cadence_coverage_percent",
      ),
    ).toEqual([
      {
        avg_cadence: 200,
        cadence_basis: "step_intervals",
        cadence_observed_seconds: 180,
        cadence_coverage_percent: 30,
      },
    ]);
    await insertValues({
      table: `${database}.activity_sensor_summary_rows`,
      format: "JSONEachRow",
      values: [
        {
          activity_id: group,
          user_id: user,
          avg_cadence: 172,
          refresh_version: 1,
          refreshed_at: new Date().toISOString(),
        },
      ],
    });
    await run("activity_summary_rows");
    expect(
      await rows(
        "activity_summary_rows",
        "avg_cadence,cadence_basis,cadence_observed_seconds,cadence_coverage_percent",
      ),
    ).toEqual([
      {
        avg_cadence: 172,
        cadence_basis: "cadence_samples",
        cadence_observed_seconds: null,
        cadence_coverage_percent: null,
      },
    ]);
  });
  it("keeps zero intervals in the weighted duration and all-zero evidence numeric", async () => {
    await steps("08:00:00", "08:01:00", 0);
    const id = await steps("08:01:00", "08:03:00", 450);
    await run("activity_step_cadence_rows");
    expect(await rows("activity_step_cadence_rows", "avg_cadence,observed_seconds")).toEqual([
      { avg_cadence: 150, observed_seconds: 180 },
    ]);
    await steps("08:01:00", "08:03:00", 0, { id, version: 2 });
    await run("activity_step_cadence_rows");
    expect(await rows("activity_step_cadence_rows", "avg_cadence,observed_seconds")).toEqual([
      { avg_cadence: 0, observed_seconds: 180 },
    ]);
  });
  it("selects one independent source and rejects a source with nested overlapping intervals", async () => {
    await steps("08:00:00", "08:09:00", 1800);
    await steps("08:01:00", "08:02:00", 150);
    await steps("08:03:00", "08:04:00", 150);
    await steps("08:00:00", "08:03:00", 510, { bundle: "com.phone", device: "Phone" });
    await run("activity_step_cadence_rows");
    expect(
      await rows("activity_step_cadence_rows", "avg_cadence,observed_seconds,source_bundle"),
    ).toEqual([{ avg_cadence: 170, observed_seconds: 180, source_bundle: "com.phone" }]);
  });
  it("uses source priority before coverage and consumes deletion of the last priority rule", async () => {
    await steps("08:00:00", "08:03:00", 600);
    await steps("08:00:00", "08:01:00", 150, { bundle: "com.phone", device: "Phone" });
    await run("activity_step_cadence_rows");
    expect((await rows("activity_step_cadence_rows"))[0]?.avg_cadence).toBe(200);
    await client.command({
      query: `INSERT INTO ${database}.sensor_device_priority VALUES ('apple_health','cadence','Phone',1,0,1)`,
    });
    await run("activity_step_cadence_rows");
    expect((await rows("activity_step_cadence_rows"))[0]?.avg_cadence).toBe(150);
    await client.command({
      query: `INSERT INTO ${database}.sensor_device_priority VALUES ('apple_health','cadence','Phone',1,1,2)`,
    });
    await run("activity_step_cadence_rows");
    expect((await rows("activity_step_cadence_rows"))[0]?.avg_cadence).toBe(200);
  });
  it("consumes latest corrections, parent deletions, and restoration without retaining stale summary cadence", async () => {
    const id = await steps("08:00:00", "08:01:00", 150);
    await run("activity_step_cadence_rows");
    await run("activity_summary_rows");
    await steps("08:00:00", "08:01:00", 180, { id, version: 2 });
    await run("activity_step_cadence_rows");
    await run("activity_summary_rows");
    expect((await rows("activity_summary_rows"))[0]?.avg_cadence).toBe(180);
    await steps("08:00:00", "08:01:00", 180, { id, version: 3, deleted: 1 });
    await run("activity_step_cadence_rows");
    await run("activity_summary_rows");
    expect((await rows("activity_summary_rows"))[0]?.avg_cadence).toBeNull();
    expect((await rows("activity_step_cadence_rows"))[0]).toMatchObject({
      avg_cadence: null,
      observed_seconds: 0,
      is_deleted: 0,
    });
    await steps("08:00:00", "08:01:00", 160, { id, version: 4 });
    await run("activity_step_cadence_rows");
    expect((await rows("activity_step_cadence_rows"))[0]?.avg_cadence).toBe(160);
  });
  it("rejects malformed, boundary-straddling, nonfinite, negative and foreign evidence", async () => {
    await steps("07:59:00", "08:01:00", 200);
    await steps("08:01:00", "08:01:00", 200);
    await steps("08:01:00", "08:02:00", -1);
    await client.command({
      query: `INSERT INTO ${database}.metric_stream_current (id,user_id,provider_id,recorded_at,channel,scalar,metadata)
        SELECT {id:UUID},{userId:UUID},'apple_health',toDateTime64('2026-10-01 08:01:00',6,'UTC'),'step_count',toFloat32('nan'),{metadata:String}`,
      query_params: {
        id: randomUUID(),
        userId: user,
        metadata: JSON.stringify({
          interval_end: "2026-10-01T08:02:00Z",
          source_bundle: "com.apple.watch",
          workout_uuids: [workout],
        }),
      },
    });
    await steps("08:01:00", "invalid", 200);
    await steps("08:01:00", "08:02:00", 200, { uuids: [randomUUID()] });
    const foreign = randomUUID();
    await activity(randomUUID(), randomUUID(), foreign, 0, randomUUID());
    await steps("08:01:00", "08:02:00", 200, { uuids: [foreign] });
    await run("activity_step_cadence_rows");
    expect(
      (await rows("activity_step_cadence_rows")).every((row) => row.avg_cadence === null),
    ).toBe(true);
  });
  it("counts the same child once across repeated associations in one canonical group", async () => {
    const member2 = randomUUID(),
      workout2 = randomUUID();
    await activity(group, member2, workout2);
    await client.command({
      query: `ALTER TABLE ${database}.deduped_activities UPDATE member_activity_ids=['${member}','${member2}'] WHERE activity_id='${group}' SETTINGS mutations_sync=2`,
    });
    const id = await steps("08:00:00", "08:01:00", 150, { uuids: [workout, workout2] });
    await steps("08:00:00", "08:01:00", 150, {
      id,
      version: 2,
      uuids: [workout, workout2, workout],
    });
    await run("activity_step_cadence_rows");
    expect(
      await rows("activity_step_cadence_rows", "avg_cadence,observed_seconds,interval_count"),
    ).toEqual([{ avg_cadence: 150, observed_seconds: 60, interval_count: 1 }]);
  });
  it("rejects distinct raw parents with identical intervals and counts before choosing another source", async () => {
    await steps("08:00:00", "08:01:00", 150);
    await steps("08:00:00", "08:01:00", 150);
    await run("activity_step_cadence_rows");
    expect(await rows("activity_step_cadence_rows", "avg_cadence,observed_seconds")).toEqual([
      { avg_cadence: null, observed_seconds: 0 },
    ]);
    await steps("08:00:00", "08:01:00", 170, { bundle: "com.phone", device: "Phone" });
    await run("activity_step_cadence_rows");
    expect(await rows("activity_step_cadence_rows", "avg_cadence,source_bundle")).toEqual([
      { avg_cadence: 170, source_bundle: "com.phone" },
    ]);
  });
  it("recomputes unchanged groups when another association is restored, moved or removed", async () => {
    const group2 = randomUUID(),
      member2 = randomUUID(),
      workout2 = randomUUID();
    await activity(group2, member2, workout2, 1);
    await steps("08:00:00", "08:01:00", 150, { uuids: [workout, workout2] });
    await run("activity_step_cadence_rows");
    expect((await rows("activity_step_cadence_rows"))[0]?.avg_cadence).toBe(150);
    await activity(group2, member2, workout2);
    await run("activity_step_cadence_rows");
    expect(
      (await rows("activity_step_cadence_rows")).every((row) => row.avg_cadence === null),
    ).toBe(true);
    await activity(group2, member2, workout2, 1);
    await run("activity_step_cadence_rows");
    const current = await rows("activity_step_cadence_rows");
    expect(current.find((row) => row.activity_id === group)?.avg_cadence).toBe(150);
    expect(current.find((row) => row.activity_id === group2)?.is_deleted).toBe(1);
  });
  it("tombstones non-running groups and restores valid runs", async () => {
    await steps("08:00:00", "08:01:00", 150);
    await run("activity_step_cadence_rows");
    await activity(group, member, workout, 1);
    await run("activity_step_cadence_rows");
    expect((await rows("activity_step_cadence_rows"))[0]?.is_deleted).toBe(1);
    await activity();
    await run("activity_step_cadence_rows");
    expect((await rows("activity_step_cadence_rows"))[0]).toMatchObject({
      avg_cadence: 150,
      is_deleted: 0,
    });
  });
  it("drains more than 100 dirty groups and keeps processed-empty rows stable", async () => {
    await seedBacklog();
    const before = await rows("activity_step_cadence_rows", "activity_id,refresh_version");
    await client.command({
      query: `ALTER TABLE ${database}.activity_source_records UPDATE refreshed_at=now64(9) WHERE 1 SETTINGS mutations_sync=2`,
    });
    await run("activity_step_cadence_rows");
    expect(await rows("activity_step_cadence_rows", "activity_id,refresh_version")).toEqual(before);
  });
  it("consumes a shared raw-day marker independently for every activity in a backlog", async () => {
    await seedBacklog();
    const before = await rows("activity_step_cadence_rows", "activity_id,refresh_version");
    await steps("08:00:00", "08:01:00", 150);
    await run("activity_step_cadence_rows");
    await run("activity_step_cadence_rows");
    const after = await rows("activity_step_cadence_rows", "activity_id,refresh_version");
    expect(
      after.every(
        (row) =>
          row.refresh_version !==
          before.find((old) => old.activity_id === row.activity_id)?.refresh_version,
      ),
    ).toBe(true);
    await run("activity_step_cadence_rows");
    expect(await rows("activity_step_cadence_rows", "activity_id,refresh_version")).toEqual(after);
  });
  it("consumes priority changes independently across bounded batches", async () => {
    await seedBacklog();
    const before = await rows("activity_step_cadence_rows", "activity_id,refresh_version");
    await client.command({
      query: `INSERT INTO ${database}.sensor_provider_priority VALUES ('apple_health','cadence',1,0,1)`,
    });
    await run("activity_step_cadence_rows");
    await run("activity_step_cadence_rows");
    const after = await rows("activity_step_cadence_rows", "activity_id,refresh_version");
    expect(
      after.every(
        (row) =>
          row.refresh_version !==
          before.find((old) => old.activity_id === row.activity_id)?.refresh_version,
      ),
    ).toBe(true);
    await run("activity_step_cadence_rows");
    expect(await rows("activity_step_cadence_rows", "activity_id,refresh_version")).toEqual(after);
  });
  it("rejects ambiguous associations outside the selected 100-key batch", async () => {
    const lastGroup = "ffffffff-ffff-ffff-ffff-ffffffffffff",
      lastWorkout = randomUUID(),
      firstWorkout = randomUUID();
    await activities([
      { id: lastGroup, memberId: randomUUID(), uuid: lastWorkout },
      ...Array.from({ length: 100 }, (_, index) => ({
        id: `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
        memberId: randomUUID(),
        uuid: index === 0 ? firstWorkout : randomUUID(),
      })),
    ]);
    await steps("08:00:00", "08:01:00", 150, { uuids: [firstWorkout, lastWorkout] });
    await run("activity_step_cadence_rows");
    expect(await rows("activity_step_cadence_rows")).toHaveLength(100);
    expect(
      (await rows("activity_step_cadence_rows")).every((row) => row.avg_cadence === null),
    ).toBe(true);
    await run("activity_step_cadence_rows");
    expect(
      (await rows("activity_step_cadence_rows")).every((row) => row.avg_cadence === null),
    ).toBe(true);
  });
  it("invalidates previous membership, scoped member repairs and changed group bounds", async () => {
    await steps("08:00:00", "08:01:00", 150);
    await run("activity_step_cadence_rows", [member]);
    expect((await rows("activity_step_cadence_rows"))[0]?.avg_cadence).toBe(150);
    await client.command({
      query: `ALTER TABLE ${database}.deduped_activities UPDATE member_activity_ids=[] WHERE activity_id='${group}' SETTINGS mutations_sync=2`,
    });
    await run("activity_step_cadence_rows");
    expect((await rows("activity_step_cadence_rows"))[0]?.avg_cadence).toBeNull();
    await activity();
    await run("activity_step_cadence_rows");
    expect((await rows("activity_step_cadence_rows"))[0]?.avg_cadence).toBe(150);
    await client.command({
      query: `ALTER TABLE ${database}.deduped_activities UPDATE started_at='2026-10-01 08:00:30',refreshed_at=now64(9) WHERE activity_id='${group}' SETTINGS mutations_sync=2`,
    });
    await run("activity_step_cadence_rows");
    expect((await rows("activity_step_cadence_rows"))[0]?.avg_cadence).toBeNull();
  });
});
