import { describe, expect, it, vi } from "vitest";
import { buildClickHouseBootstrapStatements, syncClickHouseMetricStream } from "./clickhouse.ts";

describe("buildClickHouseBootstrapStatements", () => {
  it("creates a raw metric stream projection table", () => {
    const sql = buildClickHouseBootstrapStatements().join("\n");

    expect(sql).toContain("CREATE DATABASE IF NOT EXISTS fitness");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS fitness.metric_stream");
    expect(sql).toContain("ENGINE = ReplacingMergeTree(synced_at)");
    expect(sql).toContain("allow_nullable_key = 1");
  });
});

describe("syncClickHouseMetricStream", () => {
  it("bootstraps ClickHouse and inserts Postgres metric rows", async () => {
    const command = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn().mockResolvedValue(undefined);
    const json = vi.fn().mockResolvedValue([{ max_recorded_at: null }]);
    const query = vi.fn().mockResolvedValue({ json });
    const clickHouseClient = { command, query, insert };
    const postgresClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              recorded_at: "2024-01-15T10:00:00.000Z",
              user_id: "11111111-1111-1111-1111-111111111111",
              provider_id: "garmin",
              device_id: null,
              source_type: "file",
              channel: "heart_rate",
              activity_id: "22222222-2222-2222-2222-222222222222",
              scalar: 140,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }),
    };

    const syncedRows = await syncClickHouseMetricStream({
      clickHouseClient,
      postgresClient,
      batchSize: 1,
      lookbackHours: 48,
    });

    expect(syncedRows).toBe(1);
    expect(command.mock.calls[0]?.[0]?.query).toContain("CREATE DATABASE IF NOT EXISTS fitness");
    expect(query.mock.calls[0]?.[0]?.query).toContain("fitness.metric_stream FINAL");
    expect(postgresClient.query.mock.calls[0]?.[0]).toContain("FROM fitness.metric_stream");
    expect(insert).toHaveBeenCalledWith({
      table: "fitness.metric_stream",
      format: "JSONEachRow",
      values: [
        {
          recorded_at: "2024-01-15 10:00:00.000",
          user_id: "11111111-1111-1111-1111-111111111111",
          provider_id: "garmin",
          device_id: null,
          source_type: "file",
          channel: "heart_rate",
          activity_id: "22222222-2222-2222-2222-222222222222",
          scalar: 140,
        },
      ],
    });
  });
});
