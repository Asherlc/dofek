import { TupleParam } from "@clickhouse/client";
import { describe, expect, it, vi } from "vitest";
import {
  buildDedupedSensorRecomputeInsertSql,
  processDedupedSensorDirtyKeys,
} from "./clickhouse-deduped-sensor.ts";

describe("ClickHouse deduped sensor dirty-key processing", () => {
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
    expect(processedMarkerSql).not.toContain("LIMIT 25");
  });
});
