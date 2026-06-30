import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../../db/index.ts";

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
