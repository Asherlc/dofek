import { describe, expect, it, vi } from "vitest";

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "user-1",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

import { VeloHeroProvider } from "./velohero.ts";

describe("VeloHeroProvider", () => {
  it("validate returns null", () => {
    expect(new VeloHeroProvider().validate()).toBeNull();
  });

  it("authSetup returns correct configuration", () => {
    const setup = new VeloHeroProvider().authSetup();
    expect(setup.oauthConfig.authorizeUrl).toContain("velohero.com");
    expect(setup.automatedLogin).toBeTypeOf("function");
    expect(setup.exchangeCode).toBeTypeOf("function");
  });

  it("authSetup.exchangeCode throws", async () => {
    const setup = new VeloHeroProvider().authSetup();
    await expect(setup.exchangeCode("code")).rejects.toThrow("automated login");
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
    const result = await provider.sync(mockDb, new Date("2026-01-01"));
    expect(result.provider).toBe("velohero");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("not connected");
  });

  it("sync returns error when session expired", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                providerId: "velohero",
                accessToken: "old-session",
                refreshToken: null,
                expiresAt: new Date("2020-01-01"), // expired
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
    const result = await provider.sync(mockDb, new Date("2026-01-01"));
    expect(result.errors[0]?.message).toContain("re-authenticate via Settings");
  });
});
