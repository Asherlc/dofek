import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { GenericContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.ts";
import { writeTestMigrationFiles } from "./test-helpers.ts";

// cspell:ignore conrelid contype pgcrypto pkey relnamespace segmentby

describe("metric_stream replica identity migration", () => {
  let connectionString: string;
  let container: Awaited<ReturnType<GenericContainer["start"]>> | undefined;

  beforeAll(async () => {
    container = await new GenericContainer(
      "mirror.gcr.io/timescale/timescaledb-ha:pg18.3-ts2.26.4-all",
    )
      .withEnvironment({
        POSTGRES_DB: "test",
        POSTGRES_USER: "test",
        POSTGRES_PASSWORD: "test",
      })
      .withExposedPorts(5432)
      .start();

    connectionString = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/test`;

    for (let attempt = 0; attempt < 30; attempt++) {
      const probe = new Client({ connectionString });
      try {
        await probe.connect();
        await probe.query("SELECT 1");
        return;
      } catch {
        if (attempt === 29) {
          throw new Error("Database did not become ready in time");
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      } finally {
        await probe.end().catch(() => undefined);
      }
    }
  }, 120_000);

  afterAll(async () => {
    if (container) {
      await container.stop();
    }
  });

  it("adds replica identity first, then backfills metric stream IDs and adds the primary key", async () => {
    const client = new Client({ connectionString });
    let tmpDir: string | undefined;
    await client.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
      await client.query("DROP SCHEMA IF EXISTS fitness CASCADE");
      await client.query("CREATE EXTENSION IF NOT EXISTS timescaledb");
      await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
      await client.query("CREATE SCHEMA IF NOT EXISTS fitness");
      await client.query(`
        CREATE TABLE fitness.metric_stream (
          recorded_at timestamptz NOT NULL,
          user_id uuid NOT NULL,
          provider_id text NOT NULL,
          source_type text NOT NULL,
          channel text NOT NULL,
          activity_id uuid,
          scalar real,
          vector real[]
        )
      `);
      await client.query(
        "SELECT create_hypertable('fitness.metric_stream', 'recorded_at', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE)",
      );
      await client.query(`
        ALTER TABLE fitness.metric_stream
        SET (
          timescaledb.compress = true,
          timescaledb.compress_segmentby = 'user_id,provider_id,channel',
          timescaledb.compress_orderby = 'recorded_at DESC'
        )
      `);
      await client.query(`
        INSERT INTO fitness.metric_stream (
          recorded_at, user_id, provider_id, source_type, channel, scalar
        )
        VALUES
          ('2026-01-01T00:00:00Z', gen_random_uuid(), 'garmin', 'api', 'power', 200),
          ('2026-01-02T00:00:00Z', gen_random_uuid(), 'garmin', 'api', 'power', 210),
          ('2026-01-03T00:00:00Z', gen_random_uuid(), 'garmin', 'api', 'power', 220)
      `);

      tmpDir = mkdtempSync(join(tmpdir(), "metric-stream-replica-identity-"));
      const migrationContent = readFileSync(
        join(import.meta.dirname, "../../drizzle/0007_metric_stream_primary_key.sql"),
        "utf-8",
      );
      writeTestMigrationFiles(tmpDir, [
        {
          content: migrationContent,
          file: "0007_metric_stream_primary_key.sql",
          when: 2_100_000_000_000,
        },
      ]);

      const migrationCount = await runMigrations(connectionString, tmpDir);
      expect(migrationCount).toBe(1);

      const replicaIdentityResult = await client.query<{
        replica_identity: string;
      }>(`
        -- cspell:ignore relreplident nspname relname
        SELECT class.relreplident AS replica_identity
        FROM pg_class class
        JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = 'fitness'
          AND class.relname = 'metric_stream'
      `);
      expect(replicaIdentityResult.rows).toEqual([{ replica_identity: "f" }]);

      const primaryKeyResult = await client.query<{ primary_key_count: string }>(`
        SELECT count(*) AS primary_key_count
        FROM pg_constraint
        WHERE conrelid = 'fitness.metric_stream'::regclass
          AND contype = 'p'
      `);
      expect(primaryKeyResult.rows).toEqual([{ primary_key_count: "0" }]);

      const nullableResult = await client.query<{ is_nullable: "YES" | "NO" }>(`
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'fitness'
          AND table_name = 'metric_stream'
          AND column_name = 'id'
      `);
      expect(nullableResult.rows).toEqual([{ is_nullable: "YES" }]);

      const nullIdResult = await client.query<{ missing_id_count: string }>(
        "SELECT count(*) AS missing_id_count FROM fitness.metric_stream WHERE id IS NULL",
      );
      expect(nullIdResult.rows).toEqual([{ missing_id_count: "3" }]);

      const insertedResult = await client.query<{ generated_id: string | null }>(`
        INSERT INTO fitness.metric_stream (
          recorded_at, user_id, provider_id, source_type, channel, scalar
        )
        VALUES ('2026-01-04T00:00:00Z', gen_random_uuid(), 'garmin', 'api', 'power', 230)
        RETURNING id AS generated_id
      `);
      expect(insertedResult.rows[0]?.generated_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      await client.query(`
        SELECT compress_chunk(format('%I.%I', chunk_schema, chunk_name)::regclass, if_not_compressed => true)
        FROM timescaledb_information.chunks
        WHERE hypertable_schema = 'fitness'
          AND hypertable_name = 'metric_stream'
        ORDER BY range_start
        LIMIT 1
      `);

      const chunkStateResult = await client.query<{
        chunk_count: string;
        compressed_chunk_count: string;
      }>(`
        SELECT
          count(*) AS chunk_count,
          count(*) FILTER (WHERE is_compressed) AS compressed_chunk_count
        FROM timescaledb_information.chunks
        WHERE hypertable_schema = 'fitness'
          AND hypertable_name = 'metric_stream'
      `);
      expect(chunkStateResult.rows).toEqual([{ chunk_count: "4", compressed_chunk_count: "1" }]);

      const primaryKeyMigrationContent = readFileSync(
        join(import.meta.dirname, "../../drizzle/0009_metric_stream_id_not_null_primary_key.sql"),
        "utf-8",
      );
      writeTestMigrationFiles(tmpDir, [
        {
          content: migrationContent,
          file: "0007_metric_stream_primary_key.sql",
          when: 2_100_000_000_000,
        },
        {
          content: primaryKeyMigrationContent,
          file: "0009_metric_stream_id_not_null_primary_key.sql",
          when: 2_100_000_000_001,
        },
      ]);

      const primaryKeyMigrationCount = await runMigrations(connectionString, tmpDir);
      expect(primaryKeyMigrationCount).toBe(1);

      const backfilledResult = await client.query<{ missing_id_count: string }>(
        "SELECT count(*) AS missing_id_count FROM fitness.metric_stream WHERE id IS NULL",
      );
      expect(backfilledResult.rows).toEqual([{ missing_id_count: "0" }]);

      const finalChunkStateResult = await client.query<{
        chunk_count: string;
        compressed_chunk_count: string;
      }>(`
        SELECT
          count(*) AS chunk_count,
          count(*) FILTER (WHERE is_compressed) AS compressed_chunk_count
        FROM timescaledb_information.chunks
        WHERE hypertable_schema = 'fitness'
          AND hypertable_name = 'metric_stream'
      `);
      expect(finalChunkStateResult.rows).toEqual([
        { chunk_count: "4", compressed_chunk_count: "1" },
      ]);

      const nonNullableResult = await client.query<{ is_nullable: "YES" | "NO" }>(`
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'fitness'
          AND table_name = 'metric_stream'
          AND column_name = 'id'
      `);
      expect(nonNullableResult.rows).toEqual([{ is_nullable: "NO" }]);

      const finalPrimaryKeyResult = await client.query<{
        constraint_name: string;
        columns: string;
      }>(`
        SELECT
          constraint_name,
          string_agg(column_name, ',' ORDER BY ordinal_position) AS columns
        FROM information_schema.key_column_usage
        WHERE table_schema = 'fitness'
          AND table_name = 'metric_stream'
          AND constraint_name = 'metric_stream_pkey'
        GROUP BY constraint_name
      `);
      expect(finalPrimaryKeyResult.rows).toEqual([
        { constraint_name: "metric_stream_pkey", columns: "id,recorded_at" },
      ]);
    } finally {
      if (tmpDir) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
      await client.end();
    }
  }, 120_000);
});
