import { describe, expect, it, vi } from "vitest";
import { TrainerRoadProvider } from "../trainerroad.ts";

describe("TrainerRoadProvider", () => {
  it("validate returns null", () => {
    expect(new TrainerRoadProvider().validate()).toBeNull();
  });

  it("authSetup returns correct configuration", () => {
    const setup = new TrainerRoadProvider().authSetup();
    expect(setup.oauthConfig.authorizeUrl).toContain("trainerroad.com");
    expect(setup.automatedLogin).toBeTypeOf("function");
    expect(setup.exchangeCode).toBeTypeOf("function");
  });

  it("authSetup.exchangeCode throws", async () => {
    const setup = new TrainerRoadProvider().authSetup();
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

    const provider = new TrainerRoadProvider();
    const result = await provider.sync(mockDb as never, new Date("2026-01-01"));
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
    };

    const provider = new TrainerRoadProvider();
    const result = await provider.sync(mockDb as never, new Date("2026-01-01"));
    expect(result.errors[0]?.message).toContain("username not found");
  });

  it("sync returns error when cookie expired and no env credentials", async () => {
    const originalEnv = { ...process.env };
    delete process.env.TRAINERROAD_USERNAME;
    delete process.env.TRAINERROAD_PASSWORD;

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
    };

    const provider = new TrainerRoadProvider();
    const result = await provider.sync(mockDb as never, new Date("2026-01-01"));
    expect(result.errors[0]?.message).toContain("cookie expired");

    process.env = { ...originalEnv };
  });
});
