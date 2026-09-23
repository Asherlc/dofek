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
  waitForClickHouseRows,
  waitForPeerDbApi,
} from "./test-helpers.ts";

const fixture = {
  activity: "10000000-0000-4000-8000-000000000001",
  dailyMetrics: "10000000-0000-4000-8000-000000000002",
  sleepSession: "10000000-0000-4000-8000-000000000003",
  operation: "10000000-0000-4000-8000-000000000004",
  user: "10000000-0000-4000-8000-000000000005",
  sleepStage: "10000000-0000-4000-8000-000000000006",
  foodEntry: "10000000-0000-4000-8000-000000000007",
  healthEvent: "10000000-0000-4000-8000-000000000008",
  clinicalRecord: "10000000-0000-4000-8000-000000000009",
  journalEntry: "10000000-0000-4000-8000-000000000010",
  provider: "peerdb-contract-test",
  markerBatch: "10000000-0000-4000-8000-000000000011",
  markerWatermark: "10000000-0000-4000-8000-000000000012",
  sourceAccountKey: "peerdb-contract-source-account",
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
      VALUES ('${fixture.provider}', 'PeerDB contract test');
      INSERT INTO fitness.provider_connection (user_id, provider_id)
      VALUES ('${fixture.user}', '${fixture.provider}');
      INSERT INTO fitness.provider_priority (provider_id, priority)
      VALUES ('${fixture.provider}', 10);
      INSERT INTO fitness.device_priority (provider_id, source_name_pattern, priority)
      VALUES ('${fixture.provider}', 'PeerDB Test Device', 10);
      INSERT INTO fitness.sensor_provider_priority (provider_id, channel, priority)
      VALUES ('${fixture.provider}', 'heart_rate', 10);
      INSERT INTO fitness.sensor_device_priority (
        provider_id, source_name_pattern, channel, priority
      ) VALUES ('${fixture.provider}', 'PeerDB Test Device', 'heart_rate', 10);
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
      INSERT INTO fitness.sleep_stage (id, session_id, stage, started_at, ended_at)
      VALUES (
        '${fixture.sleepStage}', '${fixture.sleepSession}', 'light',
        '2026-09-13T04:00:00Z', '2026-09-13T04:30:00Z'
      );
      INSERT INTO fitness.food_entry (
        id, provider_id, user_id, date, food_name, source_account_key
      )
      VALUES (
        '${fixture.foodEntry}', '${fixture.provider}', '${fixture.user}',
        '2026-09-13', 'PeerDB contract food', '${fixture.sourceAccountKey}'
      );
      INSERT INTO fitness.health_event (
        id, provider_id, user_id, external_id, type, value, start_date
      ) VALUES (
        '${fixture.healthEvent}', '${fixture.provider}', '${fixture.user}',
        'health-1', 'peerdb.contract', 1, '2026-09-13T12:00:00Z'
      );
      INSERT INTO fitness.clinical_record (
        id, user_id, provider_id, external_id, clinical_type, display_name,
        fhir_version, fhir, downloaded_at
      ) VALUES (
        '${fixture.clinicalRecord}', '${fixture.user}', '${fixture.provider}', 'clinical-1',
        'Observation', 'PeerDB contract record', 'R4', '{}'::jsonb, '2026-09-13T12:00:00Z'
      );
      INSERT INTO fitness.journal_question (slug, display_name, category, data_type)
      VALUES ('peerdb-contract', 'PeerDB contract', 'test', 'numeric')
      ON CONFLICT (slug) DO NOTHING;
      INSERT INTO fitness.journal_entry (
        id, date, provider_id, user_id, question_slug, answer_numeric
      ) VALUES (
        '${fixture.journalEntry}', '2026-09-13', '${fixture.provider}', '${fixture.user}',
        'peerdb-contract', 1
      );
      INSERT INTO fitness.processing_operation (id, user_id, kind, dataset_keys)
      VALUES (
        '${fixture.operation}', '${fixture.user}', 'analytics_build',
        ARRAY['activity', 'providers']
      );
      INSERT INTO fitness.processing_flow_marker (
        operation_id, dataset_key, flow_name, batch_key, source_watermark
      ) VALUES
        (
          '${fixture.operation}', 'activity', 'dofek_fitness_raw_analytics',
          '${fixture.markerBatch}', '${fixture.markerWatermark}'
        ),
        (
          '${fixture.operation}', 'providers', 'dofek_provider_inventory_raw_analytics',
          '${fixture.markerBatch}', '${fixture.markerWatermark}'
        ),
        (
          '${fixture.operation}', 'activity', 'dofek_sensor_priority_raw_analytics',
          '${fixture.markerBatch}', '${fixture.markerWatermark}'
        );
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
    const client = createPeerDbMirrorApiClientFromEnv();
    const statuses = await Promise.all(
      peerDbMirrorContracts.map((contract) =>
        waitForCanonicalMirror(client, contract.name, contract.tableMappings),
      ),
    );

    expect(statuses.map(({ currentFlowState }) => currentFlowState)).toEqual(
      peerDbMirrorContracts.map(() => "STATUS_RUNNING"),
    );
  });

  it("replicates a fixture through every managed mapping and its exact causal marker", async () => {
    await waitForClickHouseRows(clickHouseClient, [
      { table: "activity", predicate: "id = {id:UUID}", queryParams: { id: fixture.activity } },
      {
        table: "sleep_session",
        predicate: "id = {id:UUID}",
        queryParams: { id: fixture.sleepSession },
      },
      {
        table: "sleep_stage",
        predicate: "id = {id:UUID}",
        queryParams: { id: fixture.sleepStage },
      },
      {
        table: "daily_metrics",
        predicate: "id = {id:UUID}",
        queryParams: { id: fixture.dailyMetrics },
      },
      {
        table: "provider",
        predicate: "id = {provider:String}",
        queryParams: { provider: fixture.provider },
      },
      {
        table: "provider_connection",
        predicate: "user_id = {user:UUID} AND provider_id = {provider:String}",
        queryParams: { provider: fixture.provider, user: fixture.user },
      },
      {
        table: "provider_priority",
        predicate: "provider_id = {provider:String}",
        queryParams: { provider: fixture.provider },
      },
      {
        table: "device_priority",
        predicate: "provider_id = {provider:String} AND source_name_pattern = {sourceName:String}",
        queryParams: { provider: fixture.provider, sourceName: "PeerDB Test Device" },
      },
      {
        table: "user_profile",
        predicate: "id = {id:UUID}",
        queryParams: { id: fixture.user },
      },
      {
        table: "food_entry",
        predicate: "id = {id:UUID} AND source_account_key = {sourceAccountKey:String}",
        queryParams: { id: fixture.foodEntry, sourceAccountKey: fixture.sourceAccountKey },
      },
      {
        table: "health_event",
        predicate: "id = {id:UUID}",
        queryParams: { id: fixture.healthEvent },
      },
      {
        table: "clinical_record",
        predicate: "id = {id:UUID}",
        queryParams: { id: fixture.clinicalRecord },
      },
      {
        table: "journal_entry",
        predicate: "id = {id:UUID}",
        queryParams: { id: fixture.journalEntry },
      },
      {
        table: "sensor_provider_priority",
        predicate: "provider_id = {provider:String} AND channel = {channel:String}",
        queryParams: { channel: "heart_rate", provider: fixture.provider },
      },
      {
        table: "sensor_device_priority",
        predicate:
          "provider_id = {provider:String} AND source_name_pattern = {sourceName:String} AND channel = {channel:String}",
        queryParams: {
          channel: "heart_rate",
          provider: fixture.provider,
          sourceName: "PeerDB Test Device",
        },
      },
      ...peerDbMirrorContracts.map(({ processingMarker }) => ({
        table: processingMarker.destinationTableIdentifier,
        predicate:
          "operation_id = {operation:UUID} AND dataset_key = {dataset:String} AND flow_name = {flow:String} AND batch_key = {batch:String} AND source_watermark = {watermark:String}",
        queryParams: {
          batch: fixture.markerBatch,
          dataset: processingMarker.datasetKey,
          flow: processingMarker.flow,
          operation: fixture.operation,
          watermark: fixture.markerWatermark,
        },
      })),
    ]);
  });
});
