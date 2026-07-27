import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../clickhouse.ts";
import { createMigration } from "./0059_provider_change_state.ts";

const stateRowSchema = z.array(
  z.object({
    changed_at: z.string(),
    provider_id: z.string(),
  }),
);
const providerRowSchema = z.array(z.object({ provider_id: z.string() }));

describe("0059_provider_change_state migration", () => {
  const database = `provider_change_state_${randomUUID().replaceAll("-", "")}`;
  let client: ClickHouseClient;

  beforeAll(async () => {
    client = createClickHouseClientFromEnv();
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${database}.provider (
        id String,
        user_id Nullable(UUID),
        _peerdb_synced_at DateTime64(9, 'UTC'),
        _peerdb_is_deleted Int8,
        _peerdb_version Int64
      )
      ENGINE = ReplacingMergeTree(_peerdb_version)
      ORDER BY id
      SETTINGS allow_nullable_key = 1`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.provider_connection (
        user_id UUID,
        provider_id String,
        _peerdb_synced_at DateTime64(9, 'UTC'),
        _peerdb_is_deleted Int8,
        _peerdb_version Int64
      )
      ENGINE = ReplacingMergeTree(_peerdb_version)
      ORDER BY (user_id, provider_id)`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.metric_stream (
        user_id UUID,
        provider_id String,
        ingested_at DateTime64(9, 'UTC')
      )
      ENGINE = MergeTree
      ORDER BY (user_id, provider_id, ingested_at)`,
    });

    for (const table of [
      "activity",
      "daily_metrics",
      "sleep_session",
      "body_measurement_sample",
      "food_entry",
      "health_event",
      "lab_panel",
      "lab_result",
      "journal_entry",
    ]) {
      await client.command({
        query: `CREATE TABLE ${database}.${table} (
          user_id UUID,
          provider_id String,
          _peerdb_synced_at DateTime64(9, 'UTC')
        )
        ENGINE = MergeTree
        ORDER BY (user_id, provider_id, _peerdb_synced_at)`,
      });
    }
  });

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${database}` });
  });

  it("bootstraps catalogs and advances compact state from inserted changes", async () => {
    const userId = randomUUID();
    await client.command({
      query: `INSERT INTO ${database}.provider VALUES
        ('legacy_provider', {userId:UUID}, toDateTime64('2026-07-27 01:00:00', 9, 'UTC'), 0, 1),
        ('global_provider', NULL, toDateTime64('2026-07-27 01:30:00', 9, 'UTC'), 0, 1)`,
      query_params: { userId },
    });
    await client.command({
      query: `INSERT INTO ${database}.provider_connection VALUES
        (
          {userId:UUID},
          'connected_provider',
          toDateTime64('2026-07-27 02:00:00', 9, 'UTC'),
          0,
          1
        )`,
      query_params: { userId },
    });

    const tableReplacements = new Map([
      ["analytics.body_measurement_sample", `${database}.body_measurement_sample`],
      ["postgres_fitness.provider_connection", `${database}.provider_connection`],
      ["postgres_fitness.daily_metrics", `${database}.daily_metrics`],
      ["postgres_fitness.sleep_session", `${database}.sleep_session`],
      ["postgres_fitness.health_event", `${database}.health_event`],
      ["postgres_fitness.journal_entry", `${database}.journal_entry`],
      ["postgres_fitness.food_entry", `${database}.food_entry`],
      ["postgres_fitness.lab_panel", `${database}.lab_panel`],
      ["postgres_fitness.lab_result", `${database}.lab_result`],
      ["postgres_fitness.activity", `${database}.activity`],
      ["postgres_fitness.provider", `${database}.provider`],
      ["ingest.metric_stream", `${database}.metric_stream`],
      ["analytics.provider_change_state", `${database}.provider_change_state`],
      ["analytics.provider_change_from_", `${database}.provider_change_from_`],
    ]);

    for (const migrationStatement of createMigration().statements) {
      let statement = migrationStatement;
      for (const [source, target] of tableReplacements) {
        statement = statement.replaceAll(source, target);
      }
      await client.command({ query: statement });
    }

    const bootstrapResult = await client.query({
      query: `SELECT provider_id, toString(max(changed_at)) AS changed_at
        FROM ${database}.provider_change_state
        WHERE user_id = {userId:UUID}
        GROUP BY provider_id
        ORDER BY provider_id`,
      query_params: { userId },
      format: "JSONEachRow",
    });
    const bootstrapRows = stateRowSchema.parse(await bootstrapResult.json());
    expect(bootstrapRows.map((row) => row.provider_id)).toEqual([
      "connected_provider",
      "legacy_provider",
    ]);
    expect(bootstrapRows.every((row) => row.changed_at > "2026-07-27 02:00:00.000000000")).toBe(
      true,
    );
    const connectedBootstrapRow = bootstrapRows.find(
      (row) => row.provider_id === "connected_provider",
    );
    if (!connectedBootstrapRow) {
      throw new Error("Missing connected provider bootstrap state");
    }

    const targetTable = `${database}.provider_stats_bootstrap_target_${randomUUID().replaceAll("-", "")}`;
    await client.command({
      query: `CREATE TABLE ${targetTable} (
        user_id UUID,
        provider_id String,
        refreshed_at DateTime64(9, 'UTC')
      )
      ENGINE = ReplacingMergeTree(refreshed_at)
      ORDER BY (user_id, provider_id)`,
    });
    await client.command({
      query: `INSERT INTO ${targetTable} VALUES (
        {userId:UUID},
        'connected_provider',
        toDateTime64('2026-07-27 03:00:00', 9, 'UTC')
      )`,
      query_params: { userId },
    });

    const bootstrapDirtyQuery = `SELECT provider_change_state.provider_id AS provider_id
      FROM (
        SELECT user_id, provider_id, max(changed_at) AS changed_at
        FROM ${database}.provider_change_state
        GROUP BY user_id, provider_id
      ) AS provider_change_state
      LEFT JOIN ${targetTable} AS provider_stats FINAL
        ON provider_stats.user_id = provider_change_state.user_id
        AND provider_stats.provider_id = provider_change_state.provider_id
      WHERE provider_change_state.user_id = {userId:UUID}
        AND provider_change_state.provider_id = 'connected_provider'
        AND (
          provider_stats.provider_id IS NULL
          OR provider_change_state.changed_at > provider_stats.refreshed_at
        )`;
    const dirtyResult = await client.query({
      query: bootstrapDirtyQuery,
      query_params: { userId },
      format: "JSONEachRow",
    });
    expect(providerRowSchema.parse(await dirtyResult.json())).toEqual([
      { provider_id: "connected_provider" },
    ]);

    await client.command({
      query: `INSERT INTO ${targetTable}
        VALUES ({userId:UUID}, 'connected_provider', now64(9))`,
      query_params: { userId },
    });
    const convergedResult = await client.query({
      query: bootstrapDirtyQuery,
      query_params: { userId },
      format: "JSONEachRow",
    });
    expect(providerRowSchema.parse(await convergedResult.json())).toEqual([]);

    await client.command({
      query: `INSERT INTO ${database}.metric_stream VALUES
        (
          {userId:UUID},
          'connected_provider',
          toDateTime64('2026-07-27 00:30:00', 9, 'UTC')
        )`,
      query_params: { userId },
    });

    const delayedMetricResult = await client.query({
      query: `SELECT provider_id, toString(max(changed_at)) AS changed_at
        FROM ${database}.provider_change_state
        WHERE user_id = {userId:UUID}
          AND provider_id = 'connected_provider'
        GROUP BY provider_id`,
      query_params: { userId },
      format: "JSONEachRow",
    });
    const delayedMetricRows = stateRowSchema.parse(await delayedMetricResult.json());
    expect(delayedMetricRows.map((row) => row.provider_id)).toEqual(["connected_provider"]);
    const delayedMetricRow = delayedMetricRows[0];
    if (!delayedMetricRow) {
      throw new Error("Missing delayed metric provider state");
    }
    expect(delayedMetricRow.changed_at > connectedBootstrapRow.changed_at).toBe(true);

    await client.command({
      query: `INSERT INTO ${database}.provider_connection VALUES
        (
          {userId:UUID},
          'connected_provider',
          toDateTime64('2026-07-27 00:45:00', 9, 'UTC'),
          1,
          2
        )`,
      query_params: { userId },
    });

    const changedResult = await client.query({
      query: `SELECT provider_id, toString(max(changed_at)) AS changed_at
        FROM ${database}.provider_change_state
        WHERE user_id = {userId:UUID}
          AND provider_id = 'connected_provider'
        GROUP BY provider_id`,
      query_params: { userId },
      format: "JSONEachRow",
    });
    const changedRows = stateRowSchema.parse(await changedResult.json());
    expect(changedRows.map((row) => row.provider_id)).toEqual(["connected_provider"]);
    const changedRow = changedRows[0];
    if (!changedRow) {
      throw new Error("Missing provider connection tombstone state");
    }
    expect(changedRow.changed_at > delayedMetricRow.changed_at).toBe(true);
  });
});
