import { describe, expect, it, vi } from "vitest";
import {
  replaceMetricStreamBatch,
  sourceRowToMetricStream,
  writeMetricStreamBatch,
  writeMetricStreamBatchForScope,
} from "./metric-stream-writer.ts";
import { runWithTokenUser } from "./token-user-context.ts";

const operationRevision = "1000000000000000";

const mockPublishRows = vi.fn(async (rows: readonly unknown[]) =>
  rows.map((_, index) => ({
    id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  })),
);
const mockReplaceRows = vi.fn(
  async (_scope: unknown, rows: readonly unknown[], revision: string) => ({
    deleted: {
      version: 3,
      eventType: "metric_stream_deleted",
      eventId: "30000000-0000-4000-8000-000000000001",
      operationRevision: revision,
      scope: _scope,
      partitionKey: "activity:20000000-0000-4000-8000-000000000001",
    },
    rows: rows.map((_, index) => ({
      id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    })),
  }),
);

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

// ── writeMetricStreamBatch ─────────────────────────────────

describe("writeMetricStreamBatch", () => {
  it("publishes fanned-out provider rows to Redpanda without inserting into Postgres", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          generation: 0,
          operation_revision: operationRevision,
          provider_id: "withings",
          user_id: "00000000-0000-4000-8000-000000000001",
        },
      ]);
    const db = {
      execute,
      insert: vi.fn(),
      transaction: vi.fn(
        async <T>(work: (transaction: { execute: typeof execute }) => Promise<T>) =>
          work({ execute }),
      ),
    };

    const count = await runWithTokenUser("00000000-0000-4000-8000-000000000001", () =>
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
    expect(mockPublishRows).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          userId: "00000000-0000-4000-8000-000000000001",
          providerId: "withings",
          externalId: "withings-measure-1",
          channel: "body_weight",
          scalar: 72.5,
        }),
        expect.objectContaining({
          userId: "00000000-0000-4000-8000-000000000001",
          providerId: "withings",
          externalId: "withings-measure-1",
          channel: "body_fat_percentage",
          scalar: 18.4,
        }),
      ],
      { operationRevision },
    );
  });

  it("fails fast when neither the row nor token context provides a user ID", async () => {
    const db = { execute: vi.fn().mockResolvedValue([]), insert: vi.fn() };
    const originalTestTokenUserId = process.env.TEST_TOKEN_USER_ID;
    delete process.env.TEST_TOKEN_USER_ID;

    try {
      await runWithTokenUser("", async () => {
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
      });
      expect(db.insert).not.toHaveBeenCalled();
    } finally {
      if (originalTestTokenUserId === undefined) {
        delete process.env.TEST_TOKEN_USER_ID;
      } else {
        process.env.TEST_TOKEN_USER_ID = originalTestTokenUserId;
      }
    }
  });
});

// ── replaceMetricStreamBatch ───────────────────────────────

describe("replaceMetricStreamBatch", () => {
  it("publishes a scoped Redpanda replacement instead of deleting directly from Postgres", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          generation: 0,
          operation_revision: operationRevision,
          provider_id: "wahoo",
          user_id: "00000000-0000-4000-8000-000000000001",
        },
      ]);
    const db = {
      execute,
      insert: vi.fn(),
      delete: vi.fn(),
      transaction: vi.fn(
        async <T>(work: (transaction: { execute: typeof execute }) => Promise<T>) =>
          work({ execute }),
      ),
    };

    const result = await runWithTokenUser("00000000-0000-4000-8000-000000000001", () =>
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

    expect(result).toEqual({
      deletedEventId: "30000000-0000-4000-8000-000000000001",
      rowCount: 1,
    });
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(mockReplaceRows).toHaveBeenCalledWith(
      {
        activityId: "20000000-0000-4000-8000-000000000001",
        userId: "00000000-0000-4000-8000-000000000001",
      },
      [
        expect.objectContaining({
          userId: "00000000-0000-4000-8000-000000000001",
          providerId: "wahoo",
          externalId: "sample-1",
          activityId: "20000000-0000-4000-8000-000000000001",
          channel: "heart_rate",
          scalar: 142,
        }),
      ],
      operationRevision,
    );
  });

  it("fails with a clear error when the publisher cannot replace rows", async () => {
    const db = { execute: vi.fn().mockResolvedValue([]), insert: vi.fn() };

    await expect(
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
        {
          publishRows: async () => [],
        },
      ),
    ).rejects.toThrow("Metric stream publisher does not support scoped replacement");
  });
});

describe("writeMetricStreamBatchForScope", () => {
  it("publishes rows with the delete scope partition key", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          generation: 0,
          operation_revision: operationRevision,
          provider_id: "apple_health",
          user_id: "00000000-0000-4000-8000-000000000001",
        },
      ]);
    const db = {
      execute,
      insert: vi.fn(),
      transaction: vi.fn(
        async <T>(work: (transaction: { execute: typeof execute }) => Promise<T>) =>
          work({ execute }),
      ),
    };

    const count = await runWithTokenUser("00000000-0000-4000-8000-000000000001", () =>
      writeMetricStreamBatchForScope(
        db,
        {
          userId: "00000000-0000-4000-8000-000000000001",
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
      {
        operationRevision,
        partitionKey:
          "provider:00000000-0000-4000-8000-000000000001:apple_health:*:*:2026-03-30T00:00:00.000Z:*",
      },
    );
  });
});
