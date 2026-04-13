import { describe, expect, it, vi } from "vitest";

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "user-1",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

import { ZwiftProvider } from "./zwift.ts";

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
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const provider = new ZwiftProvider();
    const result = await provider.sync(mockDb, new Date("2026-01-01"));
    expect(result.provider).toBe("zwift");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("not connected");
  });

  it("sync returns error when athleteId missing from stored tokens and JWT has no sub", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                providerId: "zwift",
                accessToken: "not-a-jwt",
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
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const provider = new ZwiftProvider();
    const result = await provider.sync(mockDb, new Date("2026-01-01"));
    expect(result.errors[0]?.message).toContain("athlete ID not found");
  });

  it("self-heals missing scopes by extracting athleteId from JWT sub claim", async () => {
    // Build a fake JWT with sub claim "12345"
    const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "12345" })).toString("base64url");
    const fakeJwt = `${header}.${payload}.fake-signature`;

    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                providerId: "zwift",
                accessToken: fakeJwt,
                refreshToken: "refresh",
                expiresAt: new Date("2099-01-01"),
                scopes: null, // missing athleteId — will be self-healed
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

    // Mock fetch to return empty activities list
    const mockFetch: typeof globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const provider = new ZwiftProvider(mockFetch);
    const result = await provider.sync(mockDb, new Date("2026-01-01"));

    // Should NOT have the "athlete ID not found" error
    const athleteIdErrors = result.errors.filter((error) =>
      error.message.includes("athlete ID not found"),
    );
    expect(athleteIdErrors).toHaveLength(0);
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
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const provider = new ZwiftProvider();
    const result = await provider.sync(mockDb, new Date("2026-01-01"));
    expect(result.errors[0]?.message).toContain("no refresh token");
  });
});
