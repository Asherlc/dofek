import { beforeEach, describe, expect, it, vi } from "vitest";
import { sourceRowToMetricStream, writeMetricStreamBatch } from "./metric-stream-writer.ts";
import { runWithTokenUser } from "./token-user-context.ts";

const mockPublishRows = vi.fn(async (rows: readonly { recordedAt: Date | string }[]) =>
  rows.map((row, index) => ({
    version: 1,
    id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    recordedAt: row.recordedAt instanceof Date ? row.recordedAt.toISOString() : row.recordedAt,
  })),
);

vi.mock("../metric-stream/redpanda-producer.ts", () => ({
  getDefaultMetricStreamEventPublisher: vi.fn(async () => ({
    publishRows: mockPublishRows,
  })),
}));

beforeEach(() => {
  mockPublishRows.mockClear();
});

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

  it("publishes rows in batches", async () => {
    const db = { insert: vi.fn() };
    const rows = Array.from({ length: 7 }, (_, index) => ({
      recordedAt: new Date(`2026-03-30T12:00:0${index}Z`),
      userId: "00000000-0000-0000-0000-000000000001",
      providerId: "test",
      externalId: `sample-${index}`,
      heartRate: index,
    }));

    const count = await writeMetricStreamBatch(db, rows, "api", 3);

    expect(count).toBe(7);
    expect(mockPublishRows).toHaveBeenCalledTimes(3);
    expect(mockPublishRows.mock.calls[0]?.[0]).toHaveLength(3);
    expect(mockPublishRows.mock.calls[1]?.[0]).toHaveLength(3);
    expect(mockPublishRows.mock.calls[2]?.[0]).toHaveLength(1);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("does not publish an empty trailing batch when row count matches the batch size", async () => {
    const db = { insert: vi.fn() };
    const rows = Array.from({ length: 6 }, (_, index) => ({
      recordedAt: new Date(`2026-03-30T12:00:0${index}Z`),
      userId: "00000000-0000-0000-0000-000000000001",
      providerId: "test",
      externalId: `sample-${index}`,
      heartRate: index,
    }));

    const count = await writeMetricStreamBatch(db, rows, "api", 3);

    expect(count).toBe(6);
    expect(mockPublishRows).toHaveBeenCalledTimes(2);
    expect(mockPublishRows.mock.calls[0]?.[0]).toHaveLength(3);
    expect(mockPublishRows.mock.calls[1]?.[0]).toHaveLength(3);
    expect(mockPublishRows.mock.calls.some((call) => call[0].length === 0)).toBe(false);
  });

  it("publishes nested JSON metadata for location rows", async () => {
    const db = { insert: vi.fn() };

    const count = await writeMetricStreamBatch(
      db,
      [
        {
          recordedAt: new Date("2026-03-30T12:00:00Z"),
          userId: "00000000-0000-0000-0000-000000000001",
          providerId: "gps",
          externalId: "gps-sample-1",
          lat: 40.7128,
          lng: -74.006,
          raw: {
            label: "good",
            values: [1, true, null, { nested: "ok" }],
          },
        },
      ],
      "api",
    );

    expect(count).toBe(1);
    expect(mockPublishRows.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        channel: "location",
        metadata: {
          raw: {
            label: "good",
            values: [1, true, null, { nested: "ok" }],
          },
        },
      }),
    ]);
  });

  it("rejects non-JSON values nested in metadata arrays", async () => {
    const db = { insert: vi.fn() };

    await expect(
      writeMetricStreamBatch(
        db,
        [
          {
            recordedAt: new Date("2026-03-30T12:00:00Z"),
            userId: "00000000-0000-0000-0000-000000000001",
            providerId: "gps",
            externalId: "gps-sample-2",
            lat: 40.7128,
            lng: -74.006,
            raw: [1, Symbol("not-json")],
          },
        ],
        "api",
      ),
    ).rejects.toThrow("metric_stream ingestion metadata must be JSON serializable");
    expect(mockPublishRows).not.toHaveBeenCalled();
  });

  it("rejects non-JSON values nested in metadata objects", async () => {
    const db = { insert: vi.fn() };

    await expect(
      writeMetricStreamBatch(
        db,
        [
          {
            recordedAt: new Date("2026-03-30T12:00:00Z"),
            userId: "00000000-0000-0000-0000-000000000001",
            providerId: "gps",
            externalId: "gps-sample-3",
            lat: 40.7128,
            lng: -74.006,
            raw: { ok: "yes", bad: Symbol("not-json") },
          },
        ],
        "api",
      ),
    ).rejects.toThrow("metric_stream ingestion metadata must be JSON serializable");
    expect(mockPublishRows).not.toHaveBeenCalled();
  });

  it("rejects non-plain metadata objects", async () => {
    const db = { insert: vi.fn() };

    await expect(
      writeMetricStreamBatch(
        db,
        [
          {
            recordedAt: new Date("2026-03-30T12:00:00Z"),
            userId: "00000000-0000-0000-0000-000000000001",
            providerId: "gps",
            externalId: "gps-sample-4",
            lat: 40.7128,
            lng: -74.006,
            raw: new Date("2026-03-30T12:00:00Z"),
          },
        ],
        "api",
      ),
    ).rejects.toThrow("metric_stream ingestion metadata must be JSON serializable");

    await expect(
      writeMetricStreamBatch(
        db,
        [
          {
            recordedAt: new Date("2026-03-30T12:00:00Z"),
            userId: "00000000-0000-0000-0000-000000000001",
            providerId: "gps",
            externalId: "gps-sample-5",
            lat: 40.7128,
            lng: -74.006,
            raw: new Map([["label", "not-json"]]),
          },
        ],
        "api",
      ),
    ).rejects.toThrow("metric_stream ingestion metadata must be JSON serializable");
    expect(mockPublishRows).not.toHaveBeenCalled();
  });

  it("rejects non-positive batch sizes", async () => {
    const db = { insert: vi.fn() };
    const rows = [
      {
        recordedAt: new Date("2026-03-30T12:00:00Z"),
        userId: "00000000-0000-0000-0000-000000000001",
        providerId: "test",
        externalId: "sample-1",
        heartRate: 72,
      },
    ];

    await expect(writeMetricStreamBatch(db, rows, "api", 0)).rejects.toThrow(
      "metric_stream ingestion batchSize must be a positive integer",
    );
    await expect(writeMetricStreamBatch(db, rows, "api", -1)).rejects.toThrow(
      "metric_stream ingestion batchSize must be a positive integer",
    );
    expect(mockPublishRows).not.toHaveBeenCalled();
  });

  it("fails fast when neither the row nor token context provides a user ID", async () => {
    const db = { insert: vi.fn() };
    const previousTestTokenUserId = process.env.TEST_TOKEN_USER_ID;
    delete process.env.TEST_TOKEN_USER_ID;

    try {
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
    } finally {
      if (previousTestTokenUserId === undefined) {
        delete process.env.TEST_TOKEN_USER_ID;
      } else {
        process.env.TEST_TOKEN_USER_ID = previousTestTokenUserId;
      }
    }
    expect(db.insert).not.toHaveBeenCalled();
  });
});
