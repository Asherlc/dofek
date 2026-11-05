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

const heartRateEvent = {
  version: 1,
  id: "10000000-0000-4000-8000-000000000001",
  recordedAt: "2026-06-06T19:00:00.000Z",
  userId: "00000000-0000-4000-8000-000000000001",
  providerId: "apple_health",
  generation: 0,
  externalId: "hk:heart-rate-1",
  deviceId: "Apple Watch",
  sourceType: "api",
  channel: "heart_rate",
  activityId: null,
  scalar: 72,
  vector: null,
  point: null,
  metadata: null,
} satisfies MetricStreamEventV1;

describe("existing ClickHouse row mapping", () => {
  it("maps optional nullable fields and vector fields into ClickHouse rows", () => {
    const row = mapMetricStreamEventToClickHouseRow(
      {
        ...heartRateEvent,
        activityId: "20000000-0000-4000-8000-000000000001",
        vector: [1, 2, 3],
        point: '{"type":"Point","coordinates":[-122.4,37.8]}',
        metadata: { source: "test" },
      },
      ingestedAt,
    );

    expect(row.external_id).toBe("hk:heart-rate-1");
    expect(row.device_id).toBe("Apple Watch");
    expect(row.activity_id).toBe("20000000-0000-4000-8000-000000000001");
    expect(row.scalar).toBe(72);
    expect(row.vector).toEqual([1, 2, 3]);
    expect(row.metadata).toBe('{"source":"test"}');
    expect(row.point).toBe('{"type":"Point","coordinates":[-122.4,37.8]}');
    expect(row.generation).toBe(0);
    expect(row.version).toBe(0);
  });

  it("normalizes EWKT point events into the GeoJSON string ClickHouse read models expect", () => {
    const row = mapMetricStreamEventToClickHouseRow(
      {
        ...heartRateEvent,
        point: "SRID=4326;POINT(-122.4 37.8)",
      },
      ingestedAt,
    );

    expect(row.point).toBe('{"type":"Point","coordinates":[-122.4,37.8]}');
  });

  it("maps omitted optional fields into null ClickHouse values", () => {
    const row = mapMetricStreamEventToClickHouseRow(
      {
        version: 1,
        id: "10000000-0000-4000-8000-000000000003",
        recordedAt: "2026-06-06T19:00:00.000Z",
        userId: "00000000-0000-0000-0000-000000000001",
        providerId: "apple_health",
        generation: 0,
        sourceType: "api",
        channel: "heart_rate",
      },
      ingestedAt,
    );

    expect(row.external_id).toBeNull();
    expect(row.device_id).toBeNull();
    expect(row.activity_id).toBeNull();
    expect(row.scalar).toBeNull();
    expect(row.point).toBeNull();
    expect(row.vector).toEqual([]);
    expect(row.metadata).toBe("null");
  });

  it("maps explicit null vectors and metadata to the current ClickHouse column types", () => {
    const row = mapMetricStreamEventToClickHouseRow(heartRateEvent, ingestedAt);
    expect(row.vector).toEqual([]);
    expect(row.metadata).toBe("null");
  });
});
