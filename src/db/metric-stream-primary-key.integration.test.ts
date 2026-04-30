import { Client } from "pg";
import { GenericContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("metric_stream primary key migration", () => {
  let connectionString: string;
  let container: Awaited<ReturnType<GenericContainer["start"]>> | undefined;

  beforeAll(async () => {
    container = await new GenericContainer("timescale/timescaledb:2.26.2-pg18")
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

  it("adds a replica-safe primary key without validating a NOT NULL check", async () => {
    const client = new Client({ connectionString });
    await client.connect();
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
      await client.query("CREATE SCHEMA IF NOT EXISTS fitness");
      await client.query(`
        CREATE TABLE fitness.metric_stream_ci_repro (
          recorded_at timestamptz NOT NULL,
          user_id uuid NOT NULL,
          provider_id text NOT NULL,
          channel text NOT NULL
        )
      `);
      await client.query(
        "SELECT create_hypertable('fitness.metric_stream_ci_repro', 'recorded_at', if_not_exists => TRUE)",
      );
      await client.query(`
        ALTER TABLE fitness.metric_stream_ci_repro
        SET (
          timescaledb.compress = true,
          timescaledb.compress_segmentby = 'user_id,provider_id,channel',
          timescaledb.compress_orderby = 'recorded_at DESC'
        )
      `);
      await client.query(`
        INSERT INTO fitness.metric_stream_ci_repro (recorded_at, user_id, provider_id, channel)
        VALUES (now(), gen_random_uuid(), 'garmin', 'power')
      `);

      await client.query("ALTER TABLE fitness.metric_stream_ci_repro ADD COLUMN id uuid");
      await client.query(
        "ALTER TABLE fitness.metric_stream_ci_repro ALTER COLUMN id SET DEFAULT gen_random_uuid()",
      );
      await client.query(
        "UPDATE fitness.metric_stream_ci_repro SET id = gen_random_uuid() WHERE id IS NULL",
      );
      await client.query(
        "ALTER TABLE fitness.metric_stream_ci_repro ADD CONSTRAINT metric_stream_ci_repro_pkey PRIMARY KEY (id, recorded_at)",
      );
      await client.query(
        "ALTER TABLE fitness.metric_stream_ci_repro REPLICA IDENTITY USING INDEX metric_stream_ci_repro_pkey",
      );

      const primaryKeyResult = await client.query<{
        column_name: string;
        replica_identity: string;
      }>(`
        -- cspell:ignore attname relreplident indrelid relnamespace attrelid attnum indkey nspname relname indisprimary pgcrypto segmentby pkey
        SELECT attribute.attname AS column_name, class.relreplident AS replica_identity
        FROM pg_index index
        JOIN pg_class class ON class.oid = index.indrelid
        JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
        JOIN pg_attribute attribute
          ON attribute.attrelid = index.indrelid
         AND attribute.attnum = ANY(index.indkey)
        WHERE namespace.nspname = 'fitness'
          AND class.relname = 'metric_stream_ci_repro'
          AND index.indisprimary
        ORDER BY array_position(index.indkey, attribute.attnum)
      `);
      expect(primaryKeyResult.rows).toEqual([
        { column_name: "id", replica_identity: "i" },
        { column_name: "recorded_at", replica_identity: "i" },
      ]);

      const nullableResult = await client.query<{ is_nullable: "YES" | "NO" }>(`
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'fitness'
          AND table_name = 'metric_stream_ci_repro'
          AND column_name = 'id'
      `);
      expect(nullableResult.rows).toEqual([{ is_nullable: "NO" }]);
    } finally {
      await client.end();
    }
  }, 120_000);
});
