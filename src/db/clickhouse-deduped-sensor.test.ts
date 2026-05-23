import { TupleParam } from "@clickhouse/client";
import { describe, expect, it, vi } from "vitest";
import {
  buildDedupedSensorRecomputeInsertSql,
  buildIncrementalDedupedSensorMigrationStatements,
  processDedupedSensorDirtyKeys,
} from "./clickhouse-deduped-sensor.ts";

describe("ClickHouse deduped sensor dirty-key processing", () => {
  it("builds scalar sample SQL from the metric stream source with provider priority joins", () => {
    const sql = buildIncrementalDedupedSensorMigrationStatements().join("\n");

    expect(sql).toContain("FROM postgres_fitness.metric_stream FINAL");
    expect(sql).toContain("WHERE scalar IS NOT NULL");
    expect(sql).toContain("'heart_rate'");
    expect(sql).toContain("'right_pedal_smoothness'");
    expect(sql).toContain("FROM postgres_fitness.sensor_provider_priority FINAL");
    expect(sql).toContain("FROM postgres_fitness.sensor_device_priority FINAL");
    expect(sql).toContain("coalesce(device_priority_match.priority");
    expect(sql).toContain("assumeNotNull(metric_stream_rows.scalar) AS scalar");
  });

  it("filters recompute sample reads to pending keys", () => {
    const query = buildDedupedSensorRecomputeInsertSql(
      "SELECT user_id, channel, recorded_at FROM pending_source",
    );

    expect(query).toContain("FROM analytics.sensor_scalar_sample FINAL");
    expect(query).toContain("WHERE (user_id, channel, recorded_at) IN (");
    expect(query).toContain("SELECT user_id, channel, recorded_at\n    FROM pending_keys");
  });

  it("uses the fetched pending-key snapshot for recompute and processed markers", async () => {
    const pendingRows = [
      {
        user_id: "00000000-0000-4000-8000-000000000001",
        channel: "heart_rate",
        recorded_at: "2026-05-23 05:00:00.000000",
        max_dirty_version: "123456789",
      },
    ];
    const query = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue(pendingRows),
    });
    const command = vi.fn().mockResolvedValue(undefined);

    const processedRowCount = await processDedupedSensorDirtyKeys({ command, query }, 25);

    expect(processedRowCount).toBe(1);
    expect(query).toHaveBeenCalledWith({
      query: expect.stringContaining("LIMIT 25"),
      format: "JSONEachRow",
    });
    expect(command).toHaveBeenCalledTimes(2);

    const recomputeSql = String(command.mock.calls[0]?.[0].query);
    const processedMarkerSql = String(command.mock.calls[1]?.[0].query);
    const snapshotFragment =
      "arrayJoin({pendingKeys:Array(Tuple(UUID, String, DateTime64(6, 'UTC'), String))}) AS pending_key";

    expect(recomputeSql).toContain(snapshotFragment);
    expect(processedMarkerSql).toContain(snapshotFragment);
    expect(recomputeSql).not.toContain("00000000-0000-4000-8000-000000000001");
    expect(processedMarkerSql).not.toContain("00000000-0000-4000-8000-000000000001");
    expect(command.mock.calls[0]?.[0].query_params).toEqual({
      pendingKeys: [expect.any(TupleParam)],
    });
    expect(command.mock.calls[1]?.[0].query_params).toEqual(
      command.mock.calls[0]?.[0].query_params,
    );
    expect(processedMarkerSql).toContain(
      "dirty_keys.dirty_version <= pending_keys.max_dirty_version",
    );
    expect(processedMarkerSql).toContain("pending_keys.max_dirty_version AS dirty_version");
    expect(processedMarkerSql).not.toContain("LIMIT 25");
  });

  it("rejects dirty-key limits that are not positive integers within the batch cap", async () => {
    const query = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue([]),
    });
    const command = vi.fn().mockResolvedValue(undefined);
    const client = { command, query };

    await expect(processDedupedSensorDirtyKeys(client, 0)).rejects.toThrow("positive integer");
    await expect(processDedupedSensorDirtyKeys(client, 1.5)).rejects.toThrow("positive integer");
    await expect(processDedupedSensorDirtyKeys(client, 501)).rejects.toThrow("at most 500");

    expect(query).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });

  it("returns without recompute commands when no dirty keys are pending", async () => {
    const query = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue([]),
    });
    const command = vi.fn().mockResolvedValue(undefined);

    const processedRowCount = await processDedupedSensorDirtyKeys({ command, query }, 10);

    expect(processedRowCount).toBe(0);
    expect(query).toHaveBeenCalledWith({
      query: expect.stringContaining("LIMIT 10"),
      format: "JSONEachRow",
    });
    expect(command).not.toHaveBeenCalled();
  });
});
