import { describe, expect, it, vi } from "vitest";
import {
  INGEST_DATABASE,
  LEGACY_METRIC_STREAM_TABLE,
  METRIC_STREAM_TABLE,
} from "../../metric-stream/clickhouse-table.ts";
import type { ClickHouseCommandClient } from "../clickhouse.ts";
import * as moveMetricStreamToIngestMigration from "./0034_move_metric_stream_to_ingest.ts";

function isLegacyMetricStreamTableCountQuery(queryText: string): boolean {
  return (
    queryText.includes("system.tables") &&
    queryText.includes("postgres_fitness") &&
    queryText.includes("name = 'metric_stream'") &&
    queryText.includes("AS count")
  );
}

function mockLegacyTableCountClient(countRows: unknown): ClickHouseCommandClient {
  return {
    query: vi.fn().mockImplementation(({ query: queryText }: { query: string }) => ({
      json: vi
        .fn()
        .mockResolvedValue(
          isLegacyMetricStreamTableCountQuery(queryText) ? countRows : [{ migration_count: 0 }],
        ),
    })),
    command: vi.fn().mockResolvedValue(undefined),
  };
}

describe("0034_move_metric_stream_to_ingest", () => {
  it("creates the ingest database and metric stream table", () => {
    const migration = moveMetricStreamToIngestMigration.createMigration();

    expect(migration.id).toBe("0034_move_metric_stream_to_ingest");
    expect(migration.statements).toEqual([
      `CREATE DATABASE IF NOT EXISTS ${INGEST_DATABASE}`,
      expect.stringContaining(`CREATE TABLE IF NOT EXISTS ${METRIC_STREAM_TABLE}`),
    ]);
  });

  it("rejects a client without query method", async () => {
    const migration = moveMetricStreamToIngestMigration.createMigration();
    const client: ClickHouseCommandClient = { command: vi.fn() };

    await expect(
      migration.run?.(client, "postgres://health:fixture@db:5432/health"),
    ).rejects.toThrow("ClickHouse migrations require a query-capable client");
  });

  it("skips copy and drop when the legacy mirror table is absent", async () => {
    const migration = moveMetricStreamToIngestMigration.createMigration();
    const client = mockLegacyTableCountClient([{ count: "0" }]);

    await migration.run?.(client, "postgres://health:fixture@db:5432/health");

    expect(client.command).not.toHaveBeenCalled();
  });

  it.each([
    { label: "no rows", countRows: [] },
    { label: "a non-array response", countRows: { 0: { count: "1" } } },
    { label: "a non-string count", countRows: [{ count: 1 }] },
    { label: "a missing count field", countRows: [{ table_count: "1" }] },
    { label: "a null row", countRows: [null] },
  ])("rejects malformed legacy table count payloads ($label)", async ({ countRows }) => {
    const migration = moveMetricStreamToIngestMigration.createMigration();
    const client = mockLegacyTableCountClient(countRows);

    await expect(
      migration.run?.(client, "postgres://health:fixture@db:5432/health"),
    ).rejects.toThrow();
    expect(client.command).not.toHaveBeenCalled();
  });

  it("copies legacy metric stream rows into ingest and drops the legacy mirror", async () => {
    const migration = moveMetricStreamToIngestMigration.createMigration();
    const client = mockLegacyTableCountClient([{ count: "1" }]);

    await migration.run?.(client, "postgres://health:fixture@db:5432/health");

    expect(client.command).toHaveBeenCalledTimes(2);
    expect(client.command).toHaveBeenNthCalledWith(1, {
      query: expect.stringContaining(`INSERT INTO ${METRIC_STREAM_TABLE}`),
    });
    expect(client.command).toHaveBeenNthCalledWith(1, {
      query: expect.stringContaining(`FROM ${LEGACY_METRIC_STREAM_TABLE}`),
    });
    expect(client.command).toHaveBeenNthCalledWith(1, {
      query: expect.stringContaining("_peerdb_synced_at AS ingested_at"),
    });
    expect(client.command).toHaveBeenNthCalledWith(2, {
      query: `DROP TABLE IF EXISTS ${LEGACY_METRIC_STREAM_TABLE}`,
    });
  });

  it("copies legacy metric stream rows when the legacy table count is greater than zero", async () => {
    const migration = moveMetricStreamToIngestMigration.createMigration();
    const client = mockLegacyTableCountClient([{ count: "2" }]);

    await migration.run?.(client, "postgres://health:fixture@db:5432/health");

    expect(client.command).toHaveBeenCalledWith({
      query: expect.stringContaining(`INSERT INTO ${METRIC_STREAM_TABLE}`),
    });
    expect(client.command).toHaveBeenCalledWith({
      query: `DROP TABLE IF EXISTS ${LEGACY_METRIC_STREAM_TABLE}`,
    });
  });
});
