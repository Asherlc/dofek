import { randomUUID } from "node:crypto";
import { Client, escapeIdentifier } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CdcHealthClickHouseClient,
  checkClickHouseCdcHealth,
} from "./clickhouse-cdc-health.ts";

class FakeClickHouseClient implements CdcHealthClickHouseClient {
  async query(): Promise<{ json(): Promise<unknown> }> {
    return {
      json: async () => [
        {
          latest_peerdb_synced_at: "2026-06-03 19:30:00.000000000",
          row_count: "10",
          table_name: "sleep_session",
        },
      ],
    };
  }
}

const mirrorNames = [
  "dofek_fitness_raw_analytics",
  "dofek_provider_inventory_raw_analytics",
  "dofek_sensor_priority_raw_analytics",
] as const;

describe("checkClickHouseCdcHealth PeerDB catalog queries", () => {
  let admin: Client;
  let client: Client;
  let databaseName: string;

  beforeAll(async () => {
    const adminUrl = process.env.TEST_DATABASE_URL;
    if (!adminUrl) throw new Error("TEST_DATABASE_URL is required; run pnpm test:integration");
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    databaseName = `cdc_health_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE ${escapeIdentifier(databaseName)}`);
    const url = new URL(adminUrl);
    url.pathname = `/${databaseName}`;
    client = new Client({ connectionString: url.toString() });
    await client.connect();

    await client.query(`
      CREATE TABLE public.flows (
        name text PRIMARY KEY,
        status integer,
        updated_at timestamp,
        workflow_id text
      );
      CREATE SCHEMA peerdb_stats;
      CREATE TABLE peerdb_stats.cdc_batches (
        flow_name text NOT NULL,
        batch_id bigint NOT NULL,
        sync_time timestamp,
        end_time timestamp
      );
      CREATE TABLE peerdb_stats.cdc_table_aggregate_counts (
        flow_name text NOT NULL,
        destination_table_name text NOT NULL,
        latest_batch_id bigint NOT NULL
      );
      INSERT INTO public.flows (name, status, updated_at, workflow_id)
      VALUES ${mirrorNames.map((name) => `('${name}', 1, '2026-06-03 19:45:00', '${name}-peerflow')`).join(", ")};
      INSERT INTO peerdb_stats.cdc_batches (flow_name, batch_id, sync_time, end_time) VALUES
        ('dofek_fitness_raw_analytics', 40, '2026-06-03 19:00:00', '2026-06-03 19:00:01'),
        ('dofek_fitness_raw_analytics', 41, '2026-06-03 19:10:00', NULL),
        ('dofek_fitness_raw_analytics', 43, '2026-06-03 19:20:00', NULL);
      INSERT INTO peerdb_stats.cdc_table_aggregate_counts
        (flow_name, destination_table_name, latest_batch_id) VALUES
        ('dofek_fitness_raw_analytics', 'sleep_session', 41),
        ('dofek_fitness_raw_analytics', 'activity', 43);
    `);
  }, 60_000);

  afterAll(async () => {
    await client?.end();
    if (admin && databaseName) {
      await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(databaseName)}`);
      await admin.end();
    }
  });

  it("reports a stall with pending destination tables from the live aggregate counts table", async () => {
    const report = await checkClickHouseCdcHealth({
      postgresClient: client,
      peerDbClient: client,
      clickHouseClient: new FakeClickHouseClient(),
      now: new Date("2026-06-03T20:00:00.000Z"),
    });

    expect(report.issues).toContainEqual({
      kind: "normalization_stall",
      severity: "failure",
      message:
        "PeerDB normalization stalled for dofek_fitness_raw_analytics " +
        "tables=[activity,sleep_session] classification=NORMALIZATION_CURSOR_STALLED " +
        "normalized_batch=40 synced_batch=43 oldest_pending_batch=41",
    });
  });
});
