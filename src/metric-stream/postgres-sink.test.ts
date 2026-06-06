import { describe, expect, it, vi } from "vitest";
import type { MetricStreamEventV1 } from "./events.ts";
import {
  insertMetricStreamEventsIntoPostgres,
  type PostgresMetricStreamSinkDatabase,
} from "./postgres-sink.ts";

const event = {
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

describe("insertMetricStreamEventsIntoPostgres", () => {
  it("inserts metric-stream events with retry-safe conflict handling", async () => {
    const execute = vi.fn<PostgresMetricStreamSinkDatabase["execute"]>(async () => []);

    const inserted = await insertMetricStreamEventsIntoPostgres({ execute }, [event]);

    expect(inserted).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    const firstCall = execute.mock.calls[0];
    if (!firstCall) {
      throw new Error("expected SQL execution");
    }
    const query = JSON.stringify(firstCall[0]);
    expect(query).toContain("INSERT INTO fitness.metric_stream");
    expect(query).toContain("ON CONFLICT (id, recorded_at) DO NOTHING");
    expect(query).toContain("10000000-0000-4000-8000-000000000001");
  });

  it("does not execute SQL for an empty batch", async () => {
    const execute = vi.fn<PostgresMetricStreamSinkDatabase["execute"]>(async () => []);

    const inserted = await insertMetricStreamEventsIntoPostgres({ execute }, []);

    expect(inserted).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });
});
