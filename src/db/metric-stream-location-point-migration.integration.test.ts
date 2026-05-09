import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { GenericContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.ts";

const testDatabaseImage = "timescale/timescaledb-ha:pg18.3-ts2.26.4-all";

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

  it("backfills lat/lng scalar rows into point-valued location rows", async () => {
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
      writeFileSync(
        join(temporaryDirectory, "0018_metric_stream_location_point.sql"),
        migrationContent,
      );

      const migrationCount = await runMigrations(connectionString, temporaryDirectory);
      expect(migrationCount).toBe(1);

      const locationResult = await client.query<{
        recorded_at: Date;
        latitude: number;
        longitude: number;
        point_srid: number;
        point_latitude: number;
        point_longitude: number;
        metadata: { gps_accuracy_m?: number } | null;
      }>(`
        SELECT
          recorded_at,
          latitude,
          longitude,
          public.ST_SRID(point) AS point_srid,
          public.ST_Y(point)::double precision AS point_latitude,
          public.ST_X(point)::double precision AS point_longitude,
          metadata
        FROM fitness.metric_stream
        WHERE channel = 'location'
        ORDER BY recorded_at, latitude, longitude
      `);

      expect(locationResult.rows).toHaveLength(3);
      expect(locationResult.rows[0]?.recorded_at).toEqual(new Date("2026-01-01T00:00:00.000Z"));
      expect(locationResult.rows[0]?.latitude).toBeCloseTo(37.7749, 4);
      expect(locationResult.rows[0]?.longitude).toBeCloseTo(-122.4194, 4);
      expect(locationResult.rows[0]?.point_srid).toBe(4326);
      expect(locationResult.rows[0]?.point_latitude).toBeCloseTo(37.7749, 4);
      expect(locationResult.rows[0]?.point_longitude).toBeCloseTo(-122.4194, 4);
      expect(locationResult.rows[0]?.metadata).toEqual({ gps_accuracy_m: 6 });

      expect(locationResult.rows[1]?.recorded_at).toEqual(new Date("2026-01-01T00:00:00.000Z"));
      expect(locationResult.rows[1]?.latitude).toBeCloseTo(37.7751, 4);
      expect(locationResult.rows[1]?.longitude).toBeCloseTo(-122.4196, 4);
      expect(locationResult.rows[1]?.point_srid).toBe(4326);
      expect(locationResult.rows[1]?.point_latitude).toBeCloseTo(37.7751, 4);
      expect(locationResult.rows[1]?.point_longitude).toBeCloseTo(-122.4196, 4);
      expect(locationResult.rows[1]?.metadata).toEqual({ gps_accuracy_m: 7 });

      expect(locationResult.rows[2]?.recorded_at).toEqual(new Date("2026-01-01T00:00:01.000Z"));
      expect(locationResult.rows[2]?.latitude).toBeCloseTo(37.775, 4);
      expect(locationResult.rows[2]?.longitude).toBeCloseTo(-122.4195, 4);
      expect(locationResult.rows[2]?.point_srid).toBe(4326);
      expect(locationResult.rows[2]?.point_latitude).toBeCloseTo(37.775, 4);
      expect(locationResult.rows[2]?.point_longitude).toBeCloseTo(-122.4195, 4);
      expect(locationResult.rows[2]?.metadata).toBeNull();

      const legacyCoordinateRowsResult = await client.query<{ count: string }>(`
        SELECT count(*) AS count
        FROM fitness.metric_stream
        WHERE channel IN ('lat', 'lng')
      `);
      expect(legacyCoordinateRowsResult.rows).toEqual([{ count: "0" }]);

      const legacyAccuracyRowsResult = await client.query<{ recorded_at: Date; scalar: number }>(`
        SELECT recorded_at, scalar
        FROM fitness.metric_stream
        WHERE channel = 'gps_accuracy'
        ORDER BY recorded_at
      `);
      expect(legacyAccuracyRowsResult.rows).toEqual([
        { recorded_at: new Date("2026-01-01T00:00:02.000Z"), scalar: 9 },
      ]);
    } finally {
      if (temporaryDirectory) {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
      await client.end();
    }
  }, 180_000);
});
