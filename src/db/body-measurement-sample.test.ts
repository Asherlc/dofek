import { describe, expect, it, vi } from "vitest";
import { countMissingBodyMeasurementSamples } from "./body-measurement-sample.ts";
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
  });
});
