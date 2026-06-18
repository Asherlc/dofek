import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "user-1",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

import { TrainerRoadProvider } from "./trainerroad.ts";

describe("TrainerRoadProvider", () => {
  it("validate returns null", () => {
    expect(new TrainerRoadProvider().validate()).toBeNull();
  });

  it("authSetup returns credential-only configuration", () => {
    const setup = new TrainerRoadProvider().authSetup();
    expect(setup.automatedLogin).toBeTypeOf("function");
    expect(setup.oauthConfig).toBeUndefined();
    expect(setup.exchangeCode).toBeUndefined();
  });

  it("sync returns error when no tokens stored", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const provider = new TrainerRoadProvider();
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.provider).toBe("trainerroad");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("not connected");
  });

  it("sync returns error when username missing from stored tokens", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                providerId: "trainerroad",
                accessToken: "cookie",
                refreshToken: null,
                expiresAt: new Date("2099-01-01"),
                scopes: null, // no username
              },
            ]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const provider = new TrainerRoadProvider();
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.errors[0]?.message).toContain("username not found");
  });

  it("sync returns error when cookie expired", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                providerId: "trainerroad",
                accessToken: "old-cookie",
                refreshToken: null,
                expiresAt: new Date("2020-01-01"), // expired
                scopes: "username:testuser",
              },
            ]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const provider = new TrainerRoadProvider();
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.errors[0]?.message).toContain("TrainerRoad session expired.");
    expect(result.errors[0]?.cause).toMatchObject({ authFailureReason: "session_expired" });
  });

  describe("token expiry boundary", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function tokenDb(expiresAt: Date) {
      return {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  providerId: "trainerroad",
                  accessToken: "cookie",
                  refreshToken: null,
                  expiresAt,
                  scopes: "username:testuser",
                },
              ]),
            }),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
            onConflictDoUpdate: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
        execute: vi.fn().mockResolvedValue([]),
      };
    }

    it("treats a token expiring exactly now as expired (boundary: <= not <)", async () => {
      // Freeze time so `new Date()` inside sync equals the token's expiresAt exactly.
      const now = new Date("2026-06-01T12:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const provider = new TrainerRoadProvider();
      const result = await provider.sync(
        new SyncRun({
          db: tokenDb(new Date(now.getTime())),
          window: SyncWindow.fromSince({ since: new Date("2026-01-01") }),
        }),
      );

      expect(result.errors[0]?.message).toContain("TrainerRoad session expired.");
      expect(result.errors[0]?.cause).toMatchObject({ authFailureReason: "session_expired" });
    });
  });
});
