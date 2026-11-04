import { describe, expect, it } from "vitest";
import { mapMetricStreamEventToClickHouseRow } from "./clickhouse-row.ts";
import type { MetricStreamEventV1 } from "./events.ts";

const ingestedAt = "2026-11-03T00:00:00.123456Z";
const row: MetricStreamEventV1 = {
  version: 1,
  id: "10000000-0000-4000-8000-000000000001",
  recordedAt: "2026-06-06T19:00:00.000Z",
  userId: "00000000-0000-4000-8000-000000000001",
  providerId: "apple_health",
  generation: 0,
  sourceType: "api",
  channel: "heart_rate",
};
describe("ClickHouse source row mapping", () => {
  it("preserves the frozen ingestion timestamp and large operation revision", () => {
    expect(
      mapMetricStreamEventToClickHouseRow(
        {
          ...row,
          version: 2,
          operationRevision: "4503599627370496",
          scalar: 72,
          vector: [1, 2, 3],
          metadata: { source: "test" },
        },
        ingestedAt,
      ),
    ).toMatchObject({
      ingested_at: ingestedAt,
      version: "9007199254740993",
      scalar: 72,
      vector: [1, 2, 3],
      metadata: '{"source":"test"}',
    });
  });
  it("normalizes EWKT and preserves GeoJSON points", () => {
    expect(
      mapMetricStreamEventToClickHouseRow(
        { ...row, point: "SRID=4326;POINT(-122.4 37.8)" },
        ingestedAt,
      ).point,
    ).toBe('{"type":"Point","coordinates":[-122.4,37.8]}');
    const point = '{"type":"Point","coordinates":[-122.4,37.8]}';
    expect(mapMetricStreamEventToClickHouseRow({ ...row, point }, ingestedAt).point).toBe(point);
  });
  it("maps absent and explicit-null optional fields to the canonical raw representation", () => {
    expect(
      mapMetricStreamEventToClickHouseRow({ ...row, vector: null, metadata: null }, ingestedAt),
    ).toMatchObject({
      external_id: null,
      device_id: null,
      activity_id: null,
      scalar: null,
      point: null,
      vector: [],
      metadata: "null",
      version: 0,
    });
  });
});
