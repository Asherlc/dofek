import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../../db/index.ts";
import type { MetricStreamRowInput } from "../../metric-stream/events.ts";

const mockEnsureProvider = vi.fn().mockResolvedValue(undefined);
vi.mock("../../db/tokens.ts", () => ({
  ensureProvider: (...args: unknown[]) => mockEnsureProvider(...args),
}));

const mockInsertValues = vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn() });
const mockDb: SyncDatabase = {
  select: vi.fn(),
  insert: vi.fn().mockReturnValue({ values: mockInsertValues }),
  delete: vi.fn(),
  execute: vi.fn(),
};

vi.mock("../../db/schema/events.ts", () => ({
  imuSession: Symbol("imuSession"),
}));

const mockDecodeBin = vi.fn();
vi.mock("./decode.ts", () => ({
  decodeBin: (...args: unknown[]) => mockDecodeBin(...args),
}));

const { importZosAppBin, ZosAppProvider } = await import("./provider.ts");
const { imuSession } = await import("../../db/schema/events.ts");

function makeDecodedSession(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    hasGyro: false,
    sessionStartMs: 1_719_300_000_000,
    sampleCount: 100,
    accelFreqMode: 2,
    gyroFreqMode: 0,
    observedHz: 26,
    physicalSamples: [],
    locationSamples: [],
    samples: Array.from({ length: 100 }, (_, index) => ({
      tMs: index * 20,
      ax: 0.01,
      ay: -0.98,
      az: 0.04,
    })),
    ...overrides,
  };
}

describe("importZosAppBin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertValues.mockReturnValue({ onConflictDoNothing: vi.fn() });
  });

  it("decodes binary and inserts session into database", async () => {
    const decoded = makeDecodedSession();
    mockDecodeBin.mockReturnValue(decoded);

    const binData = Buffer.from([0x49, 0x55, 0x4d, 0x31]);
    const result = await importZosAppBin(mockDb, binData, "user-1");

    expect(mockEnsureProvider).toHaveBeenCalledWith(
      mockDb,
      "zos-app",
      "Zepp OS App",
      undefined,
      "user-1",
    );
    expect(mockDb.insert).toHaveBeenCalledWith(imuSession);
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "zos-app",
        userId: "user-1",
        sampleCount: 100,
        observedHz: 26,
        hasGyro: false,
        accelFreqMode: 2,
        gyroFreqMode: null,
      }),
    );
    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("publishes decoded physical samples to metric stream", async () => {
    const sessionStartMs = 1_719_300_000_000;
    mockDecodeBin.mockReturnValue(
      makeDecodedSession({
        sessionStartMs,
        physicalSamples: [
          { tMs: 10, channel: "heartRate", value: 72, status: 0 },
          { tMs: 15, channel: "spo2", value: 0.98, status: 0 },
          { tMs: 20, channel: "barometricPressure", value: 1012.3, status: 0 },
          { tMs: 25, channel: "compassHeading", value: 180, status: 0 },
        ],
        locationSamples: [{ tMs: 30, latitude: 37.7749, longitude: -122.4194, altitude: 18 }],
      }),
    );
    const publishedRows: MetricStreamRowInput[] = [];
    const metricStreamPublisher = {
      publishRows: vi.fn(async (rows: readonly MetricStreamRowInput[]) => {
        publishedRows.push(...rows);
        return [];
      }),
    };

    const result = await importZosAppBin(
      mockDb,
      Buffer.from([0x00]),
      "00000000-0000-0000-0000-000000000001",
      metricStreamPublisher,
    );

    expect(metricStreamPublisher.publishRows).toHaveBeenCalledTimes(1);
    expect(publishedRows.map((row) => row.channel)).toEqual([
      "heart_rate",
      "spo2",
      "barometric_pressure",
      "compass_heading",
      "location",
      "altitude",
    ]);
    expect(publishedRows.map((row) => row.recordedAt)).toEqual([
      new Date(sessionStartMs + 10),
      new Date(sessionStartMs + 15),
      new Date(sessionStartMs + 20),
      new Date(sessionStartMs + 25),
      new Date(sessionStartMs + 30),
      new Date(sessionStartMs + 30),
    ]);
    expect(publishedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "heart_rate", scalar: 72 }),
        expect.objectContaining({ channel: "spo2", scalar: 0.98 }),
        expect.objectContaining({ channel: "barometric_pressure", scalar: 1012.3 }),
        expect.objectContaining({ channel: "compass_heading", scalar: 180 }),
        expect.objectContaining({
          channel: "location",
          point: "SRID=4326;POINT(-122.4194 37.7749)",
        }),
        expect.objectContaining({ channel: "altitude", scalar: 18 }),
      ]),
    );
    expect(result.recordsSynced).toBe(1 + publishedRows.length);
    expect(JSON.stringify(vi.mocked(mockDb.execute).mock.calls)).not.toContain(
      "fitness.metric_stream",
    );
  });

  it("does not publish metric stream rows when decoded physical samples are absent", async () => {
    mockDecodeBin.mockReturnValue(makeDecodedSession());
    const metricStreamPublisher = {
      publishRows: vi.fn(async () => []),
    };

    const result = await importZosAppBin(
      mockDb,
      Buffer.from([0x00]),
      "00000000-0000-0000-0000-000000000001",
      metricStreamPublisher,
    );

    expect(metricStreamPublisher.publishRows).not.toHaveBeenCalled();
    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(JSON.stringify(vi.mocked(mockDb.execute).mock.calls)).not.toContain(
      "fitness.metric_stream",
    );
  });

  it("returns session count and publish error when physical sample publishing fails", async () => {
    mockDecodeBin.mockReturnValue(
      makeDecodedSession({
        physicalSamples: [{ tMs: 10, channel: "heartRate", value: 72, status: 0 }],
      }),
    );
    const metricStreamPublisher = {
      publishRows: vi.fn(async () => {
        throw new Error("redpanda unavailable");
      }),
    };

    const result = await importZosAppBin(
      mockDb,
      Buffer.from([0x00]),
      "00000000-0000-0000-0000-000000000001",
      metricStreamPublisher,
    );

    expect(metricStreamPublisher.publishRows).toHaveBeenCalledTimes(1);
    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(
      /^Failed to publish Zepp physical samples: redpanda unavailable/,
    );
    expect(JSON.stringify(vi.mocked(mockDb.execute).mock.calls)).not.toContain(
      "fitness.metric_stream",
    );
  });

  it("stores gyroFreqMode when hasGyro is true", async () => {
    mockDecodeBin.mockReturnValue(makeDecodedSession({ hasGyro: true, gyroFreqMode: 1 }));

    const result = await importZosAppBin(mockDb, Buffer.from([0x00]), "user-1");

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ hasGyro: true, gyroFreqMode: 1 }),
    );
    expect(result.recordsSynced).toBe(1);
  });

  it("generates externalId from sessionStartMs hash", async () => {
    mockDecodeBin.mockReturnValue(makeDecodedSession({ sessionStartMs: 1_719_300_000_000 }));

    await importZosAppBin(mockDb, Buffer.from([0x00]), "user-1");

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: expect.stringMatching(/^zos-app:[a-f0-9]{16}$/) }),
    );
  });

  it("generates distinct externalIds for segments with the same sessionStartMs", async () => {
    mockDecodeBin.mockReturnValue(makeDecodedSession({ sessionStartMs: 1_719_300_000_000 }));

    await importZosAppBin(mockDb, Buffer.from([0x01, 0x02]), "user-1");
    await importZosAppBin(mockDb, Buffer.from([0x03, 0x04]), "user-1");

    const firstExternalId = mockInsertValues.mock.calls[0]?.[0].externalId;
    const secondExternalId = mockInsertValues.mock.calls[1]?.[0].externalId;
    expect(firstExternalId).toMatch(/^zos-app:[a-f0-9]{16}$/);
    expect(secondExternalId).toMatch(/^zos-app:[a-f0-9]{16}$/);
    expect(firstExternalId).not.toBe(secondExternalId);
  });

  it("stores rawData as base64", async () => {
    mockDecodeBin.mockReturnValue(makeDecodedSession());
    const binData = Buffer.from([0x49, 0x55, 0x4d, 0x31]);

    await importZosAppBin(mockDb, binData, "user-1");

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ rawData: binData.toString("base64") }),
    );
  });

  it("converts sessionStartMs to Date for sessionStartAt", async () => {
    mockDecodeBin.mockReturnValue(makeDecodedSession({ sessionStartMs: 1_719_300_000_000 }));

    await importZosAppBin(mockDb, Buffer.from([0x00]), "user-1");

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ sessionStartAt: new Date(1_719_300_000_000) }),
    );
  });

  it("returns decode error without throwing", async () => {
    mockDecodeBin.mockImplementation(() => {
      throw new Error("Invalid magic: 0x0");
    });

    const result = await importZosAppBin(mockDb, Buffer.from([0x00]), "user-1");

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Failed to decode IMU binary");
    expect(result.errors[0]?.message).toContain("Invalid magic");
  });

  it("returns DB insert error without throwing", async () => {
    mockDecodeBin.mockReturnValue(makeDecodedSession());
    mockInsertValues.mockReturnValueOnce({
      onConflictDoNothing: () => {
        throw new Error("unique constraint violated");
      },
    });

    const result = await importZosAppBin(mockDb, Buffer.from([0x00]), "user-1");

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Failed to store IMU session");
  });

  it("uses actual sample count from decoded samples array", async () => {
    const samples = Array.from({ length: 50 }, () => ({ tMs: 0, ax: 0, ay: 0, az: 0 }));
    mockDecodeBin.mockReturnValue(makeDecodedSession({ samples }));

    await importZosAppBin(mockDb, Buffer.from([0x00]), "user-1");

    expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({ sampleCount: 50 }));
  });
});

describe("ZosAppProvider", () => {
  it("has correct id and name", () => {
    const provider = new ZosAppProvider();
    expect(provider.id).toBe("zos-app");
    expect(provider.name).toBe("Zepp OS App");
    expect(provider.importOnly).toBe(true);
  });

  it("validate returns null", () => {
    const provider = new ZosAppProvider();
    expect(provider.validate()).toBeNull();
  });
});
