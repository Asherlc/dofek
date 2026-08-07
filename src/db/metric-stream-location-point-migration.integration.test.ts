import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { GenericContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runMigrations } from "./migrate.ts";
import { writeTestMigrationFiles } from "./test-helpers.ts";

const testDatabaseImage = "mirror.gcr.io/timescale/timescaledb-ha:pg18.3-ts2.26.4-all";
const columnRowsSchema = z.array(z.object({ column_name: z.string() }));
const indexRowsSchema = z.array(z.object({ indexname: z.string() }));
const channelCountRowsSchema = z.array(z.object({ channel: z.string(), count: z.string() }));

describe("metric_stream location point migration", () => {
  let connectionString: string;
  let container: Awaited<ReturnType<GenericContainer["start"]>> | undefined;

  beforeAll(async () => {
    container = await new GenericContainer(testDatabaseImage)
      .withEnvironment({
        POSTGRES_DB: "test",
        POSTGRES_USER: "test",
        POSTGRES_PASSWORD: "test",
        PGDATA: "/var/lib/postgresql/data",
      })
      .withExposedPorts(5432)
      .start();

    connectionString = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/test`;

    for (let attempt = 0; attempt < 60; attempt++) {
      const probe = new Client({ connectionString });
      try {
        await probe.connect();
        await probe.query("SELECT 1");
        return;
      } catch {
        if (attempt === 59) {
          throw new Error("Database did not become ready in time");
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      } finally {
        await probe.end().catch(() => undefined);
      }
    }
  }, 180_000);

  afterAll(async () => {
    if (container) {
      await container.stop();
    }
  });

  it("keeps only point storage after location point cleanup migrations", async () => {
    const client = new Client({ connectionString });
    let temporaryDirectory: string | undefined;
    await client.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
      await client.query("DROP SCHEMA IF EXISTS fitness CASCADE");
      await client.query("CREATE EXTENSION IF NOT EXISTS timescaledb");
      await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
      await client.query("CREATE SCHEMA IF NOT EXISTS fitness");
      await client.query(`
        CREATE TABLE fitness.metric_stream (
          id uuid NOT NULL DEFAULT gen_random_uuid(),
          recorded_at timestamptz NOT NULL,
          user_id uuid NOT NULL,
          provider_id text NOT NULL,
          device_id text,
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

      const userId = "00000000-0000-4000-8000-000000000001";
      const activityId = "00000000-0000-4000-8000-000000000002";
      await client.query(
        `
        INSERT INTO fitness.metric_stream (
          recorded_at, user_id, provider_id, device_id, source_type, channel, activity_id, scalar
        )
        VALUES
          ('2026-01-01T00:00:00Z', $1, 'fit', 'watch', 'file', 'lat', $2, 37.7749),
          ('2026-01-01T00:00:00Z', $1, 'fit', 'watch', 'file', 'lng', $2, -122.4194),
          ('2026-01-01T00:00:00Z', $1, 'fit', 'watch', 'file', 'gps_accuracy', $2, 6),
          ('2026-01-01T00:00:00Z', $1, 'fit', 'watch', 'file', 'lat', $2, 37.7751),
          ('2026-01-01T00:00:00Z', $1, 'fit', 'watch', 'file', 'lng', $2, -122.4196),
          ('2026-01-01T00:00:00Z', $1, 'fit', 'watch', 'file', 'gps_accuracy', $2, 7),
          ('2026-01-01T00:00:01Z', $1, 'fit', 'watch', 'file', 'lat', $2, 37.7750),
          ('2026-01-01T00:00:01Z', $1, 'fit', 'watch', 'file', 'lng', $2, -122.4195),
          ('2026-01-01T00:00:02Z', $1, 'fit', 'watch', 'file', 'gps_accuracy', $2, 9)
        `,
        [userId, activityId],
      );

      temporaryDirectory = mkdtempSync(join(tmpdir(), "metric-stream-location-migration-"));
      const migrationContent = readFileSync(
        join(import.meta.dirname, "../../drizzle/0018_metric_stream_location_point.sql"),
        "utf-8",
      );
      const dropCoordinateProjectionMigrationContent = readFileSync(
        join(
          import.meta.dirname,
          "../../drizzle/0022_drop_metric_stream_coordinate_projections.sql",
        ),
        "utf-8",
      );
      writeTestMigrationFiles(temporaryDirectory, [
        {
          content: migrationContent,
          file: "0018_metric_stream_location_point.sql",
          when: 2_200_000_000_000,
        },
        {
          content: dropCoordinateProjectionMigrationContent,
          file: "0022_drop_metric_stream_coordinate_projections.sql",
          when: 2_200_000_000_001,
        },
      ]);

      const migrationCount = await runMigrations(connectionString, temporaryDirectory);
      expect(migrationCount).toBe(2);

      const columnsResult = await client.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'fitness'
          AND table_name = 'metric_stream'
          AND (
            column_name IN ('point', 'metadata', 'latitude', 'longitude')
            OR column_name LIKE 'point_%'
          )
        ORDER BY column_name
      `);
      expect(columnRowsSchema.parse(columnsResult.rows)).toEqual([
        { column_name: "metadata" },
        { column_name: "point" },
      ]);

      const pointIndexResult = await client.query<{ indexname: string }>(`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'fitness'
          AND tablename = 'metric_stream'
          AND indexname = 'metric_stream_point_gist_idx'
      `);
      expect(indexRowsSchema.parse(pointIndexResult.rows)).toEqual([
        { indexname: "metric_stream_point_gist_idx" },
      ]);

      const channelCountsResult = await client.query<{ channel: string; count: string }>(`
        SELECT channel, count(*) AS count
        FROM fitness.metric_stream
        GROUP BY channel
        ORDER BY channel
      `);
      expect(channelCountRowsSchema.parse(channelCountsResult.rows)).toEqual([
        { channel: "gps_accuracy", count: "3" },
        { channel: "lat", count: "3" },
        { channel: "lng", count: "3" },
      ]);
    } finally {
      if (temporaryDirectory) {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
      await client.end();
    }
  }, 180_000);
});
