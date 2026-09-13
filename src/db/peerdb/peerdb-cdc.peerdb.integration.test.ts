import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../clickhouse.ts";
import {
  createPeerDbMirrorApiClientFromEnv,
  setupClickHouseCdcFromEnv,
} from "../clickhouse-cdc.ts";
import { buildPostgresFitnessRawTableStatements } from "../clickhouse-raw-tables.ts";
import { runMigrations } from "../migrate.ts";
import { peerDbMirrorContracts } from "./mirror-contracts.ts";
import {
  waitForCanonicalMirror,
  waitForClickHouseFixture,
  waitForPeerDbApi,
} from "./peerdb-test-helpers.ts";

const fixture = {
  activity: "10000000-0000-4000-8000-000000000001",
  dailyMetrics: "10000000-0000-4000-8000-000000000002",
  sleepSession: "10000000-0000-4000-8000-000000000003",
  operation: "10000000-0000-4000-8000-000000000004",
  user: "10000000-0000-4000-8000-000000000005",
} as const;

describe("PeerDB CDC production contract", () => {
  let postgresClient: Client;
  let clickHouseClient: ClickHouseClient;

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    process.env.DATABASE_URL = databaseUrl;

    await runMigrations(databaseUrl);
    postgresClient = new Client({ connectionString: databaseUrl });
    await postgresClient.connect();
    clickHouseClient = createClickHouseClientFromEnv();

    await clickHouseClient.command({ query: "DROP DATABASE IF EXISTS postgres_fitness SYNC" });
    await clickHouseClient.command({ query: "CREATE DATABASE postgres_fitness" });
    for (const statement of buildPostgresFitnessRawTableStatements()) {
      await clickHouseClient.command({ query: statement });
    }

    await postgresClient.query(`
      ALTER TABLE fitness.daily_metrics
        ADD COLUMN IF NOT EXISTS stress_high_minutes integer,
        ADD COLUMN IF NOT EXISTS recovery_high_minutes integer,
        ADD COLUMN IF NOT EXISTS resilience_level text;
      ALTER TABLE fitness.sleep_session
        ADD COLUMN IF NOT EXISTS sleep_need_baseline_minutes integer,
        ADD COLUMN IF NOT EXISTS sleep_need_from_debt_minutes integer,
        ADD COLUMN IF NOT EXISTS sleep_need_from_nap_minutes integer,
        ADD COLUMN IF NOT EXISTS sleep_need_from_strain_minutes integer;

      INSERT INTO fitness.user_profile (id, name)
      VALUES ('${fixture.user}', 'PeerDB contract test');
      INSERT INTO fitness.provider (id, name)
      VALUES ('peerdb-contract-test', 'PeerDB contract test');
      INSERT INTO fitness.activity (
        id, provider_id, user_id, external_id, canonical_type, provider_type, started_at
      ) VALUES (
        '${fixture.activity}', 'peerdb-contract-test', '${fixture.user}',
        'activity-1', 'running', 'run', '2026-09-13T12:00:00Z'
      );
      INSERT INTO fitness.daily_metrics (
        id, date, provider_id, user_id, steps,
        stress_high_minutes, recovery_high_minutes, resilience_level
      ) VALUES (
        '${fixture.dailyMetrics}', '2026-09-13', 'peerdb-contract-test', '${fixture.user}',
        1234, 42, 7, 'strong'
      );
      INSERT INTO fitness.sleep_session (
        id, provider_id, user_id, external_id, started_at, ended_at,
        sleep_need_baseline_minutes, sleep_need_from_debt_minutes,
        sleep_need_from_nap_minutes, sleep_need_from_strain_minutes
      ) VALUES (
        '${fixture.sleepSession}', 'peerdb-contract-test', '${fixture.user}', 'sleep-1',
        '2026-09-13T04:00:00Z', '2026-09-13T12:00:00Z', 480, 20, 0, 15
      );
      INSERT INTO fitness.processing_operation (id, user_id, kind, dataset_keys)
      VALUES ('${fixture.operation}', '${fixture.user}', 'analytics_build', ARRAY['activity', 'sleep']);
      INSERT INTO fitness.processing_flow_marker (
        operation_id, dataset_key, flow_name, batch_key, source_watermark
      ) VALUES
        ('${fixture.operation}', 'activity', 'dofek_fitness_raw_analytics', 'activity', 'fixture-activity'),
        ('${fixture.operation}', 'sleep', 'dofek_fitness_raw_analytics', 'sleep', 'fixture-sleep');
    `);

    const peerDbApiClient = createPeerDbMirrorApiClientFromEnv();
    await waitForPeerDbApi(peerDbApiClient);
    await setupClickHouseCdcFromEnv();
  });

  afterAll(async () => {
    await postgresClient?.end();
    await clickHouseClient?.close?.();
  });

  it("normalizes activities, sleep, and daily metrics while excluding retired fields", async () => {
    await waitForClickHouseFixture(clickHouseClient, fixture);

    const columnResult = await clickHouseClient.query<{ name: string }>({
      query: `
        SELECT name
        FROM system.columns
        WHERE database = 'postgres_fitness'
          AND table IN ('daily_metrics', 'sleep_session')
          AND name IN (
            'stress_high_minutes', 'recovery_high_minutes', 'resilience_level',
            'sleep_need_baseline_minutes', 'sleep_need_from_debt_minutes',
            'sleep_need_from_nap_minutes', 'sleep_need_from_strain_minutes'
          )
      `,
      format: "JSONEachRow",
    });
    await expect(columnResult.json()).resolves.toEqual([]);
  });

  it("reports the live mirror mapping as the exact production contract", async () => {
    const contract = peerDbMirrorContracts[0];
    const status = await waitForCanonicalMirror(
      createPeerDbMirrorApiClientFromEnv(),
      contract.name,
      contract.tableMappings,
    );

    expect(status.currentFlowState).toBe("STATUS_RUNNING");
  });
});
