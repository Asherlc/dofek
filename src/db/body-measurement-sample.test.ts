import { describe, expect, it, vi } from "vitest";
import {
  backfillMissingBodyMeasurementSamples,
  countMissingBodyMeasurementSamples,
} from "./body-measurement-sample.ts";
import type { ClickHouseClient } from "./clickhouse.ts";

describe("countMissingBodyMeasurementSamples", () => {
  it("formats DateTime64 query parameters for ClickHouse", async () => {
    const query = vi.fn(async () => ({ json: async () => [] }));
    const client: ClickHouseClient = {
      command: vi.fn(async () => undefined),
      query,
    };

    await countMissingBodyMeasurementSamples(client, {
      start: new Date("2026-06-21T00:00:00.000Z"),
      end: new Date("2026-07-21T12:34:56.789Z"),
    });

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: {
          start: "2026-06-21 00:00:00.000",
          end: "2026-07-21 12:34:56.789",
        },
      }),
    );
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("FROM ingest.metric_stream AS metric_stream FINAL"),
      }),
    );
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining(
          "LEFT ANTI JOIN analytics.body_measurement_sample AS existing_sample FINAL",
        ),
      }),
    );
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("existing_sample.recorded_at >= {start:DateTime64(6)}"),
      }),
    );
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("existing_sample.recorded_at < {end:DateTime64(6)}"),
      }),
    );
  });
});

describe("backfillMissingBodyMeasurementSamples", () => {
  it("returns the insert summary without running a count query", async () => {
    const query = vi.fn(async () => ({ json: async () => [] }));
    const command = vi.fn(async () => ({ summary: { written_rows: "12" } }));
    const client: ClickHouseClient = { command, query };

    const insertedCount = await backfillMissingBodyMeasurementSamples(client, {
      start: new Date("2026-06-21T00:00:00.000Z"),
      end: new Date("2026-07-21T12:34:56.789Z"),
    });

    expect(insertedCount).toBe(12);
    expect(query).not.toHaveBeenCalled();
    expect(command).toHaveBeenCalledOnce();
  });
});
