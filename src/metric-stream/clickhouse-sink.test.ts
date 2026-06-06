import { describe, expect, it, vi } from "vitest";
import { insertMetricStreamEventsIntoClickHouse } from "./clickhouse-sink.ts";
import type { MetricStreamEventV1 } from "./events.ts";

const heartRateEvent = {
  version: 1,
  id: "10000000-0000-4000-8000-000000000001",
  recordedAt: "2026-06-06T19:00:00.000Z",
  userId: "00000000-0000-0000-0000-000000000001",
  providerId: "apple_health",
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

const imuEvent = {
  ...heartRateEvent,
  id: "10000000-0000-4000-8000-000000000002",
  channel: "imu",
} satisfies MetricStreamEventV1;

describe("insertMetricStreamEventsIntoClickHouse", () => {
  it("inserts non-IMU events into the existing analytics source table", async () => {
    const insert = vi.fn(async () => undefined);

    const inserted = await insertMetricStreamEventsIntoClickHouse({ insert }, [heartRateEvent]);

    expect(inserted).toBe(1);
    expect(insert).toHaveBeenCalledWith({
      table: "postgres_fitness.metric_stream",
      format: "JSONEachRow",
      values: [
        expect.objectContaining({
          id: heartRateEvent.id,
          recorded_at: heartRateEvent.recordedAt,
          channel: "heart_rate",
          _peerdb_is_deleted: 0,
        }),
      ],
    });
  });

  it("skips IMU events because the analytics mirror intentionally excludes them", async () => {
    const insert = vi.fn(async () => undefined);

    const inserted = await insertMetricStreamEventsIntoClickHouse({ insert }, [imuEvent]);

    expect(inserted).toBe(0);
    expect(insert).not.toHaveBeenCalled();
  });
});
