import { describe, expect, it, vi } from "vitest";
import type { MetricStreamInsert } from "./metric-stream-writer.ts";
import {
  metricStreamConflictTarget,
  replaceMetricStreamBatch,
  sourceRowToMetricStream,
  writeMetricStream,
  writeMetricStreamBatch,
  writeMetricStreamBatchForScope,
} from "./metric-stream-writer.ts";
import { metricStream } from "./schema.ts";
import { runWithTokenUser } from "./token-user-context.ts";

const mockPublishRows = vi.fn(async (rows: readonly unknown[]) =>
  rows.map((_, index) => ({
    id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  })),
);
const mockReplaceRows = vi.fn(async (_scope: unknown, rows: readonly unknown[]) => ({
  deleted: {
    version: 1,
    eventType: "metric_stream_deleted",
    scope: _scope,
    partitionKey: "activity:20000000-0000-4000-8000-000000000001",
  },
  rows: rows.map((_, index) => ({
    id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  })),
}));

vi.mock("../metric-stream/redpanda-producer.ts", () => ({
  getDefaultMetricStreamEventPublisher: vi.fn(async () => ({
    publishRows: mockPublishRows,
    replaceRows: mockReplaceRows,
  })),
}));

// ── sourceRowToMetricStream ────────────────────────────────

describe("sourceRowToMetricStream", () => {
  it("converts camelCase Drizzle fields to metric_stream rows", () => {
    const rows = sourceRowToMetricStream(
      {
        recordedAt: new Date("2026-03-30T12:00:00Z"),
        providerId: "wahoo",
        activityId: "act-1",
        heartRate: 142,
        power: 250,
        cadence: 90,
      },
      "file",
    );

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.channel).sort()).toEqual(["cadence", "heart_rate", "power"]);
    expect(rows.find((row) => row.channel === "heart_rate")?.scalar).toBe(142);
  });

  it("skips non-metric fields (recordedAt, providerId, activityId, etc.)", () => {
    const rows = sourceRowToMetricStream(
      {
        recordedAt: new Date("2026-03-30T12:00:00Z"),
        providerId: "oura",
        heartRate: 60,
      },
      "api",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.channel).toBe("heart_rate");
  });

  it("uses sourceName as deviceId", () => {
    const rows = sourceRowToMetricStream(
      {
        recordedAt: new Date("2026-03-30T12:00:00Z"),
        providerId: "wahoo",
        sourceName: "Wahoo TICKR",
        heartRate: 142,
      },
      "file",
    );

    expect(rows[0]?.deviceId).toBe("Wahoo TICKR");
  });

  it("preserves provider external ids on every fanned-out channel", () => {
    const rows = sourceRowToMetricStream(
      {
        recordedAt: new Date("2026-03-30T12:00:00Z"),
        providerId: "withings",
        externalId: "withings-measure-1",
        weightKg: 72.5,
        bodyFatPct: 18.4,
      },
      "api",
    );

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.externalId === "withings-measure-1")).toBe(true);
  });

  it("preserves all base fields", () => {
    const rows = sourceRowToMetricStream(
      {
        recordedAt: new Date("2026-03-30T12:00:00Z"),
        userId: "user-1",
        providerId: "strava",
        activityId: "act-2",
        heartRate: 150,
      },
      "api",
    );

    expect(rows[0]).toMatchObject({
      recordedAt: new Date("2026-03-30T12:00:00Z"),
      userId: "user-1",
      providerId: "strava",
      activityId: "act-2",
      sourceType: "api",
      channel: "heart_rate",
      scalar: 150,
    });
  });

  it("does not fan out coordinates as metric channels", () => {
    const rows = sourceRowToMetricStream(
      {
        recordedAt: new Date("2026-03-30T12:00:00Z"),
        providerId: "wahoo",
        activityId: "act-1",
        lat: 40.7128,
        lng: -74.006,
        altitude: 10.5,
        speed: 3.2,
      },
      "file",
    );

    expect(rows.map((row) => row.channel).sort()).toEqual(["altitude", "location", "speed"]);
    expect(rows.find((row) => row.channel === "location")).toMatchObject({
      scalar: null,
      vector: null,
      point: "SRID=4326;POINT(-74.006 40.7128)",
    });
    expect(rows.find((row) => row.channel === "location")).not.toHaveProperty("latitude");
    expect(rows.find((row) => row.channel === "location")).not.toHaveProperty("longitude");
  });

  it("keeps GPS accuracy metadata on the location metric", () => {
    const rows = sourceRowToMetricStream(
      {
        recordedAt: new Date("2026-03-30T12:00:00Z"),
        providerId: "wahoo",
        lat: 40.7128,
        lng: -74.006,
        gpsAccuracy: 3,
      },
      "file",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: "location",
      metadata: { gps_accuracy_m: 3 },
    });
  });

  it("keeps Core Location horizontal accuracy distinct from FIT GPS accuracy", () => {
    const rows = sourceRowToMetricStream(
      {
        recordedAt: new Date("2026-03-30T12:00:00Z"),
        providerId: "apple_health",
        lat: 40.7128,
        lng: -74.006,
        horizontalAccuracy: 5.2,
        gpsAccuracy: 3,
      },
      "api",
    );

    expect(rows[0]?.metadata).toEqual({
      horizontal_accuracy_m: 5.2,
      gps_accuracy_m: 3,
    });
  });

  it("converts body measurement fields to metric_stream rows", () => {
    const rows = sourceRowToMetricStream(
      {
        recordedAt: new Date("2026-03-30T12:00:00Z"),
        providerId: "withings",
        sourceName: "Withings Body+",
        weightKg: 72.5,
        bodyFatPct: 18.4,
        systolicBp: 118,
      },
      "api",
    );

    expect(rows).toEqual([
      {
        recordedAt: new Date("2026-03-30T12:00:00Z"),
        userId: undefined,
        providerId: "withings",
        externalId: "withings:no-activity:Withings Body+:body_weight:2026-03-30T12:00:00.000Z",
        activityId: undefined,
        deviceId: "Withings Body+",
        sourceType: "api",
        channel: "body_weight",
        scalar: 72.5,
      },
      {
        recordedAt: new Date("2026-03-30T12:00:00Z"),
        userId: undefined,
        providerId: "withings",
        externalId:
          "withings:no-activity:Withings Body+:body_fat_percentage:2026-03-30T12:00:00.000Z",
        activityId: undefined,
        deviceId: "Withings Body+",
        sourceType: "api",
        channel: "body_fat_percentage",
        scalar: 18.4,
      },
      {
        recordedAt: new Date("2026-03-30T12:00:00Z"),
        userId: undefined,
        providerId: "withings",
        externalId:
          "withings:no-activity:Withings Body+:systolic_blood_pressure:2026-03-30T12:00:00.000Z",
        activityId: undefined,
        deviceId: "Withings Body+",
        sourceType: "api",
        channel: "systolic_blood_pressure",
        scalar: 118,
      },
    ]);
  });
});

// ── writeMetricStream ──────────────────────────────────────

describe("writeMetricStream", () => {
  it("returns 0 for empty input", async () => {
    const insertBatch = vi.fn();
    const count = await writeMetricStream(insertBatch, []);
    expect(count).toBe(0);
    expect(insertBatch).not.toHaveBeenCalled();
  });

  it("inserts rows in batches", async () => {
    const insertedBatches: MetricStreamInsert[][] = [];
    const insertBatch = vi.fn(async (batch: MetricStreamInsert[]) => {
      insertedBatches.push(batch);
    });

    const rows: MetricStreamInsert[] = Array.from({ length: 7 }, (_, index) => ({
      recordedAt: new Date(),
      providerId: "test",
      externalId: `sample-${index}`,
      sourceType: "api",
      channel: "heart_rate",
      scalar: index,
    }));

    const count = await writeMetricStream(insertBatch, rows, 3);

    expect(count).toBe(7);
    expect(insertedBatches).toHaveLength(3); // 3 + 3 + 1
    expect(insertedBatches[0]).toHaveLength(3);
    expect(insertedBatches[1]).toHaveLength(3);
    expect(insertedBatches[2]).toHaveLength(1);
  });

  it("uses a conservative default batch size", async () => {
    const insertedBatches: MetricStreamInsert[][] = [];
    const insertBatch = vi.fn(async (batch: MetricStreamInsert[]) => {
      insertedBatches.push(batch);
    });

    const rows: MetricStreamInsert[] = Array.from({ length: 1001 }, (_, index) => ({
      recordedAt: new Date(),
      providerId: "test",
      externalId: `sample-${index}`,
      sourceType: "api",
      channel: "heart_rate",
      scalar: index,
    }));

    const count = await writeMetricStream(insertBatch, rows);

    expect(count).toBe(1001);
    expect(insertedBatches).toHaveLength(2);
    expect(insertedBatches[0]).toHaveLength(1000);
    expect(insertedBatches[1]).toHaveLength(1);
  });

  it("rejects rows without external IDs", async () => {
    const insertBatch = vi.fn();
    const rows: MetricStreamInsert[] = [
      {
        recordedAt: new Date("2026-03-30T12:00:00Z"),
        providerId: "test",
        sourceType: "api",
        channel: "heart_rate",
        scalar: 72,
      },
    ];

    await expect(writeMetricStream(insertBatch, rows)).rejects.toThrow(
      "metric_stream ingestion rows require externalId for idempotency",
    );
    expect(insertBatch).not.toHaveBeenCalled();
  });

  it("rejects rows with whitespace-only external IDs", async () => {
    const insertBatch = vi.fn();
    const rows: MetricStreamInsert[] = [
      {
        recordedAt: new Date("2026-03-30T12:00:00Z"),
        providerId: "test",
        externalId: "   ",
        sourceType: "api",
        channel: "heart_rate",
        scalar: 72,
      },
    ];

    await expect(writeMetricStream(insertBatch, rows)).rejects.toThrow(
      "metric_stream ingestion rows require externalId for idempotency",
    );
    expect(insertBatch).not.toHaveBeenCalled();
  });
});

// ── writeMetricStreamBatch ─────────────────────────────────

describe("writeMetricStreamBatch", () => {
  it("publishes fanned-out provider rows to Redpanda without inserting into Postgres", async () => {
    const db = { insert: vi.fn() };

    const count = await runWithTokenUser("00000000-0000-0000-0000-000000000001", () =>
      writeMetricStreamBatch(
        db,
        [
          {
            recordedAt: new Date("2026-03-30T12:00:00Z"),
            providerId: "withings",
            externalId: "withings-measure-1",
            weightKg: 72.5,
            bodyFatPct: 18.4,
          },
        ],
        "api",
      ),
    );

    expect(count).toBe(2);
    expect(db.insert).not.toHaveBeenCalled();
    expect(mockPublishRows).toHaveBeenCalledWith([
      expect.objectContaining({
        userId: "00000000-0000-0000-0000-000000000001",
        providerId: "withings",
        externalId: "withings-measure-1",
        channel: "body_weight",
        scalar: 72.5,
      }),
      expect.objectContaining({
        userId: "00000000-0000-0000-0000-000000000001",
        providerId: "withings",
        externalId: "withings-measure-1",
        channel: "body_fat_percentage",
        scalar: 18.4,
      }),
    ]);
  });

  it("fails fast when neither the row nor token context provides a user ID", async () => {
    const db = { insert: vi.fn() };

    await expect(
      writeMetricStreamBatch(
        db,
        [
          {
            recordedAt: new Date("2026-03-30T12:00:00Z"),
            providerId: "withings",
            externalId: "withings-measure-2",
            weightKg: 72.5,
          },
        ],
        "api",
      ),
    ).rejects.toThrow("metric_stream ingestion rows require userId");
    expect(db.insert).not.toHaveBeenCalled();
  });
});

// ── replaceMetricStreamBatch ───────────────────────────────

describe("replaceMetricStreamBatch", () => {
  it("publishes a scoped Redpanda replacement instead of deleting directly from Postgres", async () => {
    const db = { insert: vi.fn(), delete: vi.fn() };

    const count = await runWithTokenUser("00000000-0000-0000-0000-000000000001", () =>
      replaceMetricStreamBatch(
        db,
        { activityId: "20000000-0000-4000-8000-000000000001" },
        [
          {
            recordedAt: new Date("2026-03-30T12:00:00Z"),
            providerId: "wahoo",
            externalId: "sample-1",
            activityId: "20000000-0000-4000-8000-000000000001",
            heartRate: 142,
          },
        ],
        "file",
      ),
    );

    expect(count).toBe(1);
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(mockReplaceRows).toHaveBeenCalledWith(
      { activityId: "20000000-0000-4000-8000-000000000001" },
      [
        expect.objectContaining({
          userId: "00000000-0000-0000-0000-000000000001",
          providerId: "wahoo",
          externalId: "sample-1",
          activityId: "20000000-0000-4000-8000-000000000001",
          channel: "heart_rate",
          scalar: 142,
        }),
      ],
    );
  });
});

describe("writeMetricStreamBatchForScope", () => {
  it("publishes rows with the delete scope partition key", async () => {
    const db = { insert: vi.fn() };

    const count = await runWithTokenUser("00000000-0000-0000-0000-000000000001", () =>
      writeMetricStreamBatchForScope(
        db,
        {
          userId: "00000000-0000-0000-0000-000000000001",
          providerId: "apple_health",
          recordedAtStart: "2026-03-30T00:00:00.000Z",
        },
        [
          {
            recordedAt: new Date("2026-03-30T12:00:00Z"),
            providerId: "apple_health",
            externalId: "sample-1",
            heartRate: 142,
          },
        ],
        "file",
      ),
    );

    expect(count).toBe(1);
    expect(mockPublishRows).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          channel: "heart_rate",
          scalar: 142,
        }),
      ],
      "provider:00000000-0000-0000-0000-000000000001:apple_health:*:*:2026-03-30T00:00:00.000Z:*",
    );
  });
});

// ── metricStreamConflictTarget ─────────────────────────────

describe("metricStreamConflictTarget", () => {
  it("uses the provider sample identity as the duplicate key", () => {
    expect(metricStreamConflictTarget(metricStream)).toEqual([
      metricStream.userId,
      metricStream.providerId,
      metricStream.externalId,
      metricStream.channel,
      metricStream.recordedAt,
    ]);
  });
});
