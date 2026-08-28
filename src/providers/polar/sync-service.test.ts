import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncWindow } from "../sync-window.ts";

const mocks = vi.hoisted(() => ({
  ensureProvider: vi.fn(),
  loadTokens: vi.fn(),
  withSyncLog: vi.fn(),
  getExercises: vi.fn(),
  getSleep: vi.fn(),
  getDailyActivity: vi.fn(),
  getNightlyRecharge: vi.fn(),
  polarOAuthConfig: vi.fn(),
}));

vi.mock("../../db/tokens.ts", () => ({
  ensureProvider: mocks.ensureProvider,
  loadTokens: mocks.loadTokens,
  saveTokens: vi.fn(),
  deleteTokens: vi.fn(),
}));

vi.mock("../../db/sync-log.ts", () => ({
  withSyncLog: mocks.withSyncLog,
}));

vi.mock("./oauth.ts", () => ({
  POLAR_API_BASE: "https://polar.example.test",
  polarOAuthConfig: mocks.polarOAuthConfig,
}));

vi.mock("./client.ts", () => ({
  PolarClient: class {
    getExercises = mocks.getExercises;
    getSleep = mocks.getSleep;
    getDailyActivity = mocks.getDailyActivity;
    getNightlyRecharge = mocks.getNightlyRecharge;
  },
  PolarNotFoundError: class PolarNotFoundError extends Error {},
  PolarUnauthorizedError: class PolarUnauthorizedError extends Error {},
}));

import { PolarSyncService } from "./sync-service.ts";

const window = new SyncWindow({
  since: new Date("2026-06-01T00:00:00.000Z"),
  until: new Date("2026-06-30T23:59:59.999Z"),
});

function service() {
  const db = Object.create(null);
  const fetchFn: typeof globalThis.fetch = vi.fn();
  return new PolarSyncService({
    db,
    providerId: "polar",
    providerName: "Polar",
    fetchFn,
    userId: "00000000-0000-4000-8000-000000000001",
  });
}

describe("PolarSyncService", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reports a missing OAuth token without beginning provider requests", async () => {
    mocks.loadTokens.mockResolvedValue(null);

    const result = await service().run(window);

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens found for Polar");
    expect(mocks.getExercises).not.toHaveBeenCalled();
  });

  it("syncs each empty Polar collection with a current access token", async () => {
    mocks.loadTokens.mockResolvedValue({
      accessToken: "active-token",
      refreshToken: null,
      expiresAt: new Date("2027-07-01T00:00:00.000Z"),
    });
    mocks.getExercises.mockResolvedValue([]);
    mocks.getSleep.mockResolvedValue([]);
    mocks.getDailyActivity.mockResolvedValue([]);
    mocks.getNightlyRecharge.mockResolvedValue([]);
    mocks.withSyncLog.mockImplementation(
      async (
        _db: unknown,
        _providerId: string,
        _type: string,
        work: () => Promise<{ result: number }>,
      ) => (await work()).result,
    );

    const result = await service().run(window);

    expect(result).toEqual({ recordsSynced: 0, errors: [] });
    expect(mocks.ensureProvider).toHaveBeenCalledWith(
      expect.anything(),
      "polar",
      "Polar",
      "https://polar.example.test",
    );
    expect(mocks.getExercises).toHaveBeenCalledOnce();
    expect(mocks.getSleep).toHaveBeenCalledOnce();
    expect(mocks.getDailyActivity).toHaveBeenCalledOnce();
    expect(mocks.getNightlyRecharge).toHaveBeenCalledOnce();
  });

  it("uses an expired long-lived access token when no refresh token exists", async () => {
    mocks.loadTokens.mockResolvedValue({
      accessToken: "long-lived-token",
      refreshToken: null,
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    mocks.getExercises.mockResolvedValue([]);
    mocks.getSleep.mockResolvedValue([]);
    mocks.getDailyActivity.mockResolvedValue([]);
    mocks.getNightlyRecharge.mockResolvedValue([]);
    mocks.withSyncLog.mockImplementation(
      async (
        _db: unknown,
        _providerId: string,
        _type: string,
        work: () => Promise<{ result: number }>,
      ) => (await work()).result,
    );

    const result = await service().run(window);

    expect(result).toEqual({ recordsSynced: 0, errors: [] });
    expect(mocks.polarOAuthConfig).not.toHaveBeenCalled();
    expect(mocks.getExercises).toHaveBeenCalledOnce();
  });

  it("fails clearly when an expired refreshable token has no OAuth configuration", async () => {
    mocks.loadTokens.mockResolvedValue({
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    mocks.polarOAuthConfig.mockReturnValue(null);

    const result = await service().run(window);

    expect(result.recordsSynced).toBe(0);
    expect(result.errors[0]?.message).toBe("OAuth config required to refresh Polar tokens");
    expect(mocks.getExercises).not.toHaveBeenCalled();
  });
});
