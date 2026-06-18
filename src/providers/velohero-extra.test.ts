import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncWindow } from "./sync-window.ts";

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "user-1",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

import { VeloHeroProvider } from "./velohero.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("VeloHeroProvider", () => {
  it("validate returns null", () => {
    expect(new VeloHeroProvider().validate()).toBeNull();
  });

  it("authSetup returns credential-only configuration", () => {
    const setup = new VeloHeroProvider().authSetup();
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

    const provider = new VeloHeroProvider();
    const result = await provider.sync(mockDb, SyncWindow.fromSince(new Date("2026-01-01")));
    expect(result.provider).toBe("velohero");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("not connected");
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeLessThan(60_000);
  });

  it("sync returns error when session expires exactly now", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                providerId: "velohero",
                accessToken: "old-session",
                refreshToken: null,
                expiresAt: new Date("2026-01-01T00:00:00Z"),
                scopes: "userId:123",
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

    const provider = new VeloHeroProvider();
    const result = await provider.sync(mockDb, SyncWindow.fromSince(new Date("2026-01-01")));
    expect(result.errors[0]?.message).toContain("VeloHero session expired.");
    expect(result.errors[0]?.cause).toMatchObject({ authFailureReason: "session_expired" });
    expect(result.duration).toBe(0);
  });
});
