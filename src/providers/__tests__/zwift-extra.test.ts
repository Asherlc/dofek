import { describe, expect, it, vi } from "vitest";
import { ZwiftProvider } from "../zwift.ts";

describe("ZwiftProvider", () => {
  it("validate returns null", () => {
    expect(new ZwiftProvider().validate()).toBeNull();
  });

  it("authSetup returns correct configuration", () => {
    const setup = new ZwiftProvider().authSetup();
    expect(setup.oauthConfig.clientId).toBe("Zwift Game Client");
    expect(setup.oauthConfig.authorizeUrl).toContain("zwift");
    expect(setup.automatedLogin).toBeTypeOf("function");
    expect(setup.exchangeCode).toBeTypeOf("function");
  });

  it("authSetup.exchangeCode throws", async () => {
    const setup = new ZwiftProvider().authSetup();
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
    };

    const provider = new ZwiftProvider();
    // @ts-expect-error mock DB
    const result = await provider.sync(mockDb, new Date("2026-01-01"));
    expect(result.provider).toBe("zwift");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("not connected");
  });

  it("sync returns error when athleteId missing from stored tokens", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                providerId: "zwift",
                accessToken: "token",
                refreshToken: "refresh",
                expiresAt: new Date("2099-01-01"),
                scopes: null, // no athleteId
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
    };

    const provider = new ZwiftProvider();
    // @ts-expect-error mock DB
    const result = await provider.sync(mockDb, new Date("2026-01-01"));
    expect(result.errors[0]?.message).toContain("athlete ID not found");
  });

  it("sync returns error when token expired and no refresh token", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                providerId: "zwift",
                accessToken: "old-token",
                refreshToken: null,
                expiresAt: new Date("2020-01-01"), // expired
                scopes: "athleteId:12345",
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
    };

    const provider = new ZwiftProvider();
    // @ts-expect-error mock DB
    const result = await provider.sync(mockDb, new Date("2026-01-01"));
    expect(result.errors[0]?.message).toContain("token expired");
  });
});
