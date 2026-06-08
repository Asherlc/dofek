import { describe, expect, it, vi } from "vitest";
import type { PostgresMetricStreamBackfillDatabase } from "../src/metric-stream/postgres-backfill-source.ts";
import type { MetricStreamEventPublisher } from "../src/metric-stream/redpanda-producer.ts";
import { backfillMetricStreamToRedpanda } from "./backfill-metric-stream-to-redpanda.ts";

describe("backfillMetricStreamToRedpanda", () => {
  it("publishes historical rows with the original Postgres ids and resumes by cursor", async () => {
    const databaseRows = [
      {
        id: "10000000-0000-4000-8000-000000000001",
        recorded_at: new Date("2026-06-06T12:00:00.000Z"),
        user_id: "00000000-0000-0000-0000-000000000001",
        provider_id: "apple_health",
        external_id: "hk:heart-rate-1",
        device_id: "Apple Watch",
        source_type: "api",
        channel: "heart_rate",
        activity_id: null,
        scalar: 72,
        vector: null,
        point: "SRID=4326;POINT(-122.4 37.8)",
        metadata: { source: "fixture" },
      },
    ];
    const execute = vi
      .fn<PostgresMetricStreamBackfillDatabase["execute"]>()
      .mockResolvedValueOnce(databaseRows)
      .mockResolvedValueOnce([]);
    const publishRows = vi.fn<MetricStreamEventPublisher["publishRows"]>(async (rows) =>
      rows.map((row) => ({
        version: 1,
        id: row.id ?? "missing-id",
        recordedAt: new Date(row.recordedAt).toISOString(),
        userId: row.userId,
        providerId: row.providerId,
        externalId: row.externalId ?? null,
        deviceId: row.deviceId ?? null,
        sourceType: row.sourceType,
        channel: row.channel,
        activityId: row.activityId ?? null,
        scalar: row.scalar ?? null,
        vector: row.vector ?? null,
        point: row.point ?? null,
        metadata: row.metadata ?? null,
      })),
    );

    const result = await backfillMetricStreamToRedpanda({
      batchSize: 1,
      db: { execute },
      end: new Date("2026-06-07T00:00:00.000Z"),
      publisher: { publishRows },
      start: new Date("2026-06-06T00:00:00.000Z"),
    });

    expect(result).toEqual({
      batches: 1,
      published: 1,
      scanned: 1,
      lastCursor: {
        id: "10000000-0000-4000-8000-000000000001",
        recordedAt: "2026-06-06T12:00:00.000Z",
      },
    });
    expect(publishRows).toHaveBeenCalledWith([
      {
        id: "10000000-0000-4000-8000-000000000001",
        recordedAt: "2026-06-06T12:00:00.000Z",
        userId: "00000000-0000-0000-0000-000000000001",
        providerId: "apple_health",
        externalId: "hk:heart-rate-1",
        deviceId: "Apple Watch",
        sourceType: "api",
        channel: "heart_rate",
        activityId: null,
        scalar: 72,
        vector: null,
        point: "SRID=4326;POINT(-122.4 37.8)",
        metadata: { source: "fixture" },
      },
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
