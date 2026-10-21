import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildDedupedSensorBackfillSql,
  buildIncrementalDedupedSensorStatements,
  buildSensorScalarSampleBackfillSql,
} from "./clickhouse-deduped-sensor.ts";
import { clickHouseMigrations } from "./clickhouse-migrations/registry.ts";
import { buildPostgresFitnessActivityRawTableStatement } from "./clickhouse-raw-tables.ts";
import { readModelSql, renderDbtModelSql } from "./read-model-sql-test-helpers.ts";

describe("deduped sensor source activity attribution", () => {
  const database = `sensor_attribution_${randomUUID().replaceAll("-", "")}`;
  const user = "00000000-0000-0000-0000-000000000001";
  const member = "00000000-0000-0000-0000-000000000002";
  let client: ReturnType<typeof createClient>;
  const scope = (query: string) =>
    query
      .replaceAll("analytics.", `${database}.`)
      .replaceAll("ingest.", `${database}.`)
      .replaceAll("postgres_fitness.", `${database}.`)
      .replaceAll("database = 'analytics'", `database = '${database}'`);
  const command = (query: string) => client.command({ query: scope(query) });
  const render = (sql: string) =>
    renderDbtModelSql(sql, { isIncremental: false })
      .replace(/{{ source\('[^']+', '([^']+)'\) }}/g, `${database}.$1`)
      .replace(/{{ ref\('([^']+)'\) }}/g, `${database}.$1`);

  beforeAll(async () => {
    if (!process.env.CLICKHOUSE_URL) throw new Error("CLICKHOUSE_URL is required");
    client = createClient({
      url: process.env.CLICKHOUSE_URL,
      clickhouse_settings: { join_use_nulls: 1, optimize_on_insert: 0 },
    });
    await command(`CREATE DATABASE ${database}`);
    await command(`CREATE TABLE ${database}.metric_stream (
      id UUID, activity_id Nullable(UUID), user_id UUID, recorded_at DateTime64(6, 'UTC'),
      channel String, provider_id String, device_id Nullable(String), scalar Nullable(Float32),
      external_id Nullable(String), source_type Nullable(String), metadata String,
      ingested_at DateTime64(9), is_deleted Int8, version Int64
    ) ENGINE = ReplacingMergeTree(version) ORDER BY id`);
    await command(
      `CREATE VIEW ${database}.metric_stream_freshness AS SELECT * FROM ${database}.metric_stream`,
    );
    await command(`SYSTEM STOP MERGES ${database}.metric_stream`);
    await command(`CREATE TABLE ${database}.sensor_provider_priority
      (provider_id String, channel String, priority UInt16, _peerdb_is_deleted UInt8)
      ENGINE = ReplacingMergeTree ORDER BY (provider_id, channel)`);
    await command(`CREATE TABLE ${database}.sensor_device_priority
      (provider_id String, source_name_pattern String, channel String, priority UInt16, _peerdb_is_deleted UInt8)
      ENGINE = ReplacingMergeTree ORDER BY (provider_id, source_name_pattern, channel)`);
    await command(
      `INSERT INTO ${database}.sensor_provider_priority VALUES ('winner', 'power', 1, 0), ('loser', 'power', 2, 0)`,
    );
  });

  afterAll(async () => {
    await command(`DROP DATABASE IF EXISTS ${database} SYNC`);
    await client.close();
  });

  async function resetSensorFixture(): Promise<void> {
    await command(`TRUNCATE TABLE ${database}.metric_stream`);
    await command(`DROP TABLE IF EXISTS ${database}.sensor_scalar_sample SYNC`);
    await command(`DROP TABLE IF EXISTS ${database}.deduped_sensor SYNC`);
    // Winner starts linked, then the latest version explicitly removes the link.
    // A lower-priority sample at that same timestamp must not supply its member ID.
    await command(`INSERT INTO ${database}.metric_stream
      (id, activity_id, user_id, recorded_at, channel, provider_id, device_id, scalar,
       ingested_at, is_deleted, version) VALUES
      ('00000000-0000-0000-0000-000000000010', '${member}', '${user}', '2026-09-07 10:00:00', 'power', 'winner', NULL, 100, now64(9), 0, 1),
      ('00000000-0000-0000-0000-000000000010', NULL, '${user}', '2026-09-07 10:00:00', 'power', 'winner', NULL, 101, now64(9), 0, 2),
      ('00000000-0000-0000-0000-000000000011', '${member}', '${user}', '2026-09-07 10:00:00', 'power', 'loser', NULL, 200, now64(9), 0, 1),
      ('00000000-0000-0000-0000-000000000012', '${member}', '${user}', '2026-09-07 10:01:00', 'power', 'winner', NULL, 102, now64(9), 0, 1)`);
  }

  async function refreshSensorModels(path: string): Promise<void> {
    for (const statement of buildIncrementalDedupedSensorStatements()) await command(statement);
    await command(`SYSTEM STOP MERGES ${database}.sensor_scalar_sample`);
    if (path === "dbt") {
      const staging = readFileSync(
        new URL("../../analytics/models/staging/sensor_scalar_sample.sql", import.meta.url),
        "utf8",
      );
      await command(`INSERT INTO ${database}.sensor_scalar_sample ${render(staging)}`);
      const deduped = render(
        readModelSql("deduped_sensor.sql")
          .replaceAll(
            "{{ ref('sensor_scalar_sample').render() }}",
            `${database}.sensor_scalar_sample`,
          )
          .replaceAll(
            "{{ ref('sensor_scalar_sample') }}",
            `(SELECT * FROM ${database}.sensor_scalar_sample
              WHERE _peerdb_synced_at >= toStartOfDay(now64(9)))`,
          ),
      );
      await command(
        `INSERT INTO ${database}.deduped_sensor SELECT * EXCEPT (source_refreshed_at)
          FROM (${deduped})`,
      );
    } else {
      await command(buildSensorScalarSampleBackfillSql());
      await command(buildDedupedSensorBackfillSql());
    }
  }

  it.each(["dbt", "manual"])(
    "%s derives heart rate from beat intervals with source provenance and heart-rate priorities",
    async (path) => {
      await resetSensorFixture();
      await command(`INSERT INTO ${database}.sensor_provider_priority VALUES
        ('interval-source', 'heart_rate', 9, 0), ('interval-source', 'rr_interval_ms', 99, 0)`);
      await command(`INSERT INTO ${database}.sensor_device_priority VALUES
        ('interval-source', 'strap-a', 'heart_rate', 3, 0)`);
      await command(`INSERT INTO ${database}.metric_stream
        (id, activity_id, user_id, recorded_at, channel, provider_id, device_id, scalar,
         external_id, source_type, metadata, ingested_at, is_deleted, version) VALUES
        ('00000000-0000-0000-0000-000000000021', NULL, '${user}', '2026-09-07 10:00:00', 'rr_interval_ms', 'interval-source', 'strap-a', 750,
         'beat-1', 'ble', '{"measurement_kind":"direct"}', now64(9), 0, 1),
        ('00000000-0000-0000-0000-000000000022', '${member}', '${user}', '2026-09-07 10:01:00', 'rr_interval_ms', 'interval-source', 'strap-b', 500,
         'beat-2', 'ble', '{}', now64(9), 0, 1)`);
      await refreshSensorModels(path);
      const result = await client.query({
        query: `SELECT channel, scalar, provider_id, device_id, source_external_id, source_type,
          measurement_kind, source_activity_id, provider_priority
          FROM ${database}.deduped_sensor FINAL
          WHERE channel = 'heart_rate' AND is_deleted = 0 ORDER BY recorded_at`,
        format: "JSONEachRow",
      });
      expect(await result.json()).toEqual([
        {
          channel: "heart_rate",
          scalar: 80,
          provider_id: "interval-source",
          device_id: "strap-a",
          source_external_id: "beat-1",
          source_type: "ble",
          measurement_kind: "estimated",
          source_activity_id: null,
          provider_priority: 3,
        },
        {
          channel: "heart_rate",
          scalar: 120,
          provider_id: "interval-source",
          device_id: "strap-b",
          source_external_id: "beat-2",
          source_type: "ble",
          measurement_kind: "estimated",
          source_activity_id: member,
          provider_priority: 9,
        },
      ]);
      if (path === "dbt") {
        const staging = readFileSync(
          new URL("../../analytics/models/staging/sensor_scalar_sample.sql", import.meta.url),
          "utf8",
        );
        const types = await client.query({
          query: `SELECT DISTINCT toTypeName(_peerdb_is_deleted) AS deletion_type FROM (${render(staging)})`,
          format: "JSONEachRow",
        });
        expect(await types.json()).toEqual([{ deletion_type: "Int8" }]);
      }
    },
  );

  it.each(["dbt", "manual"])(
    "%s prefers reported heart rate to a derived reading from the same source",
    async (path) => {
      await resetSensorFixture();
      await command(`INSERT INTO ${database}.metric_stream
        (id, user_id, recorded_at, channel, provider_id, device_id, scalar,
         ingested_at, is_deleted, version) VALUES
        ('00000000-0000-0000-0000-000000000001', '${user}', '2026-09-07 10:00:00', 'rr_interval_ms', 'combined-source', 'strap', 500, now64(9), 0, 1),
        ('00000000-0000-0000-0000-000000000099', '${user}', '2026-09-07 10:00:00', 'heart_rate', 'combined-source', 'strap', 115, now64(9), 0, 1)`);
      await refreshSensorModels(path);
      const result = await client.query({
        query: `SELECT scalar, source_metric_stream_id FROM ${database}.deduped_sensor FINAL
          WHERE channel = 'heart_rate' AND is_deleted = 0`,
        format: "JSONEachRow",
      });
      expect(await result.json()).toEqual([
        { scalar: 115, source_metric_stream_id: "00000000-0000-0000-0000-000000000099" },
      ]);
    },
  );

  it.each(["dbt", "manual"])(
    "%s retracts derived readings when intervals become invalid or are deleted",
    async (path) => {
      await resetSensorFixture();
      const samples = ["0", "-500", "NULL", "toFloat32('inf')", "toFloat32('nan')", "750"];
      for (const index of samples.keys()) {
        const id = `00000000-0000-0000-0000-00000000003${index}`;
        await command(`INSERT INTO ${database}.metric_stream
          (id, user_id, recorded_at, channel, provider_id, scalar, ingested_at, is_deleted, version)
          VALUES ('${id}', '${user}', '2026-09-07 10:00:0${index}', 'rr_interval_ms', 'interval-source', 500, now64(9), 0, 1)`);
      }
      await refreshSensorModels(path);
      const initial = await client.query({
        query: `SELECT count() AS samples FROM ${database}.deduped_sensor FINAL
          WHERE channel = 'heart_rate' AND is_deleted = 0`,
        format: "JSONEachRow",
      });
      expect(await initial.json()).toEqual([{ samples: 6 }]);
      for (const [index, scalar] of samples.entries()) {
        const id = `00000000-0000-0000-0000-00000000003${index}`;
        await command(`INSERT INTO ${database}.metric_stream
          (id, user_id, recorded_at, channel, provider_id, scalar, ingested_at, is_deleted, version)
          VALUES ('${id}', '${user}', '2026-09-07 10:00:0${index}', 'rr_interval_ms', 'interval-source', ${scalar}, now64(9), ${index === 5 ? 1 : 0}, 2)`);
      }
      await refreshSensorModels(path);
      const result = await client.query({
        query: `SELECT is_deleted FROM ${database}.deduped_sensor FINAL
          WHERE channel = 'heart_rate' ORDER BY recorded_at`,
        format: "JSONEachRow",
      });
      expect(await result.json()).toEqual(Array.from({ length: 6 }, () => ({ is_deleted: 1 })));
    },
  );

  it("keeps earlier reported heart rate when a matching interval arrives and is invalidated in a later microbatch", async () => {
    await resetSensorFixture();
    await command(`INSERT INTO ${database}.metric_stream
      (id, user_id, recorded_at, channel, provider_id, device_id, scalar,
       ingested_at, is_deleted, version) VALUES
      ('00000000-0000-0000-0000-000000000099', '${user}', '2026-09-07 10:00:00', 'heart_rate', 'combined-source', 'strap', 115, now64(9) - INTERVAL 2 DAY, 0, 1)`);
    await refreshSensorModels("manual");
    await command(`INSERT INTO ${database}.metric_stream
      (id, user_id, recorded_at, channel, provider_id, device_id, scalar,
       ingested_at, is_deleted, version) VALUES
      ('00000000-0000-0000-0000-000000000001', '${user}', '2026-09-07 10:00:00', 'rr_interval_ms', 'combined-source', 'strap', 500, now64(9), 0, 1)`);
    await refreshSensorModels("dbt");
    const reported = [{ scalar: 115, is_deleted: 0 }];
    const afterArrival = await client.query({
      query: `SELECT scalar, is_deleted FROM ${database}.deduped_sensor FINAL WHERE channel = 'heart_rate'`,
      format: "JSONEachRow",
    });
    expect(await afterArrival.json()).toEqual(reported);
    await command(`INSERT INTO ${database}.metric_stream
      (id, user_id, recorded_at, channel, provider_id, device_id, scalar,
       ingested_at, is_deleted, version) VALUES
      ('00000000-0000-0000-0000-000000000001', '${user}', '2026-09-07 10:00:00', 'rr_interval_ms', 'combined-source', 'strap', 0, now64(9), 0, 2)`);
    await refreshSensorModels("dbt");
    const afterInvalidation = await client.query({
      query: `SELECT scalar, is_deleted FROM ${database}.deduped_sensor FINAL WHERE channel = 'heart_rate'`,
      format: "JSONEachRow",
    });
    expect(await afterInvalidation.json()).toEqual(reported);
  });

  it.each(["dbt", "manual"])(
    "%s retains the winning sample's nullable linkage, including latest null updates",
    async (path) => {
      await resetSensorFixture();
      if (path === "dbt") {
        const staging = readFileSync(
          new URL("../../analytics/models/staging/sensor_scalar_sample.sql", import.meta.url),
          "utf8",
        );
        await command(
          `CREATE TABLE ${database}.sensor_scalar_sample ENGINE = ReplacingMergeTree(_peerdb_version) ORDER BY id AS ${render(staging)}`,
        );
        await command(
          `CREATE TABLE ${database}.deduped_sensor ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, channel, recorded_at) AS ${render(readModelSql("deduped_sensor.sql"))}`,
        );
      } else {
        for (const sql of buildIncrementalDedupedSensorStatements()) await command(sql);
        await command(buildSensorScalarSampleBackfillSql());
        await command(buildDedupedSensorBackfillSql());
      }
      const result = await client.query({
        query: `SELECT scalar, provider_id, source_metric_stream_id, source_activity_id FROM ${database}.deduped_sensor FINAL ORDER BY recorded_at`,
        format: "JSONEachRow",
      });
      expect(await result.json()).toEqual([
        {
          scalar: 101,
          provider_id: "winner",
          source_metric_stream_id: "00000000-0000-0000-0000-000000000010",
          source_activity_id: null,
        },
        {
          scalar: 102,
          provider_id: "winner",
          source_metric_stream_id: "00000000-0000-0000-0000-000000000012",
          source_activity_id: member,
        },
      ]);
    },
  );

  it("upgrades existing sensor tables idempotently and keeps historical rows unlinked until refresh", async () => {
    await resetSensorFixture();
    const migration = clickHouseMigrations("postgres://test").find(
      (entry) => entry.id === "0080_sensor_source_activity_id",
    );
    expect(migration).toBeDefined();
    if (!migration?.run) throw new Error("0077 must handle absent dbt tables");
    const run = migration.run;
    const applyMigration = () =>
      run(
        {
          command: async (options) => {
            await client.command({ ...options, query: scope(options.query) });
          },
          query: (options) => client.query({ ...options, query: scope(options.query) }),
        },
        "postgres://test",
      );
    await applyMigration(); // Fresh deployments may not have either dbt target yet.
    for (const sql of buildIncrementalDedupedSensorStatements()) await command(sql);
    await command(buildSensorScalarSampleBackfillSql());
    await command(buildDedupedSensorBackfillSql());
    for (const [table, column] of [
      ["sensor_scalar_sample", "activity_id"],
      ["deduped_sensor", "source_activity_id"],
    ]) {
      await command(`ALTER TABLE ${database}.${table} DROP COLUMN IF EXISTS ${column}`);
    }
    await applyMigration();
    await applyMigration();
    const result = await client.query({
      query: `SELECT source_activity_id FROM ${database}.deduped_sensor FINAL`,
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      { source_activity_id: null },
      { source_activity_id: null },
    ]);
    await command(`TRUNCATE TABLE ${database}.sensor_scalar_sample`);
    await command(buildSensorScalarSampleBackfillSql());
    await command(buildDedupedSensorBackfillSql());
    const refreshed = await client.query({
      query: `SELECT source_activity_id FROM ${database}.deduped_sensor FINAL ORDER BY recorded_at`,
      format: "JSONEachRow",
    });
    expect(await refreshed.json()).toEqual([
      { source_activity_id: null },
      { source_activity_id: member },
    ]);
  });

  it("bootstraps nullable membership in the same physical position as migration 0076", async () => {
    await command(buildPostgresFitnessActivityRawTableStatement());
    await command(`INSERT INTO ${database}.activity (id, provider_id, user_id, canonical_type, provider_type, started_at, created_at, group_id)
      VALUES ('${member}', 'winner', '${user}', 'cycling', 'cycling', now64(6), now64(6), NULL)`);
    const result = await client.query({
      query: `SELECT name, type FROM system.columns WHERE database = '${database}' AND table = 'activity' ORDER BY position DESC LIMIT 1`,
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([{ name: "group_id", type: "Nullable(UUID)" }]);
  });
});
