import { describe, expect, it, vi } from "vitest";

const {
  mockEnsureProvider,
  mockSaveTokens,
  mockInvalidateByPrefix,
  mockGetAllProviders,
  mockEnsureProvidersRegistered,
} = vi.hoisted(() => ({
  mockEnsureProvider: vi.fn(),
  mockSaveTokens: vi.fn(),
  mockInvalidateByPrefix: vi.fn(),
  mockGetAllProviders: vi.fn(),
  mockEnsureProvidersRegistered: vi.fn(),
}));

vi.mock("dofek/db/tokens", () => ({
  ensureProvider: mockEnsureProvider,
  saveTokens: mockSaveTokens,
}));

vi.mock("dofek/providers/registry", () => ({
  getAllProviders: mockGetAllProviders,
}));

vi.mock("../routers/sync.ts", () => ({
  ensureProvidersRegistered: mockEnsureProvidersRegistered,
}));

vi.mock("../lib/cache.ts", () => ({
  queryCache: { invalidateByPrefix: mockInvalidateByPrefix },
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC.context<{ db: unknown; userId: string; timezone: string }>().create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
  };
});

import type { Provider } from "dofek/providers/types";
import { credentialAuthRouter } from "./credential-auth.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

function stubProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "test-provider",
    name: "Test Provider",
    validate: () => null,
    sync: async () => ({ provider: "test-provider", recordsSynced: 0, errors: [], duration: 0 }),
    ...overrides,
  };
}

describe("credentialAuthRouter", () => {
  const createCaller = createTestCallerFactory(credentialAuthRouter);

  describe("signIn", () => {
    it("calls automatedLogin and saves tokens for a valid provider", async () => {
      const fakeTokens = {
        accessToken: "access-123",
        refreshToken: "refresh-456",
        expiresAt: new Date("2026-04-01"),
        scopes: "userId:42",
      };
      const mockAutomatedLogin = vi.fn().mockResolvedValue(fakeTokens);

      const provider = stubProvider({
        id: "eight-sleep",
        name: "Eight Sleep",
        authSetup: () => ({
          oauthConfig: {
            clientId: "",
            authorizeUrl: "",
            tokenUrl: "",
            redirectUri: "",
            scopes: [],
          },
          exchangeCode: async () => {
            throw new Error("not supported");
          },
          automatedLogin: mockAutomatedLogin,
          apiBaseUrl: "https://api.8slp.net",
        }),
      });

      mockGetAllProviders.mockReturnValue([provider]);
      mockEnsureProvidersRegistered.mockResolvedValue(undefined);
      mockEnsureProvider.mockResolvedValue(undefined);
      mockSaveTokens.mockResolvedValue(undefined);
      mockInvalidateByPrefix.mockResolvedValue(undefined);

      const mockDb = { execute: vi.fn() };
      const caller = createCaller({ db: mockDb, userId: "user-abc", timezone: "UTC" });

      const result = await caller.signIn({
        providerId: "eight-sleep",
        username: "user@example.com",
        password: "secret123",
      });

      expect(result.success).toBe(true);
      expect(mockAutomatedLogin).toHaveBeenCalledWith("user@example.com", "secret123");
      expect(mockEnsureProvider).toHaveBeenCalledWith(
        mockDb,
        "eight-sleep",
        "Eight Sleep",
        "https://api.8slp.net",
        "user-abc",
      );
      expect(mockSaveTokens).toHaveBeenCalledWith(mockDb, "eight-sleep", fakeTokens);
      expect(mockInvalidateByPrefix).toHaveBeenCalledWith("user-abc:sync.providers");
    });

    it("throws for unknown provider", async () => {
      mockGetAllProviders.mockReturnValue([]);
      mockEnsureProvidersRegistered.mockResolvedValue(undefined);

      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-abc",
        timezone: "UTC",
      });

      await expect(
        caller.signIn({ providerId: "nonexistent", username: "a", password: "b" }),
      ).rejects.toThrow("Unknown provider: nonexistent");
    });

    it("throws when provider does not support credential auth", async () => {
      const provider = stubProvider({
        id: "strava",
        name: "Strava",
        authSetup: () => ({
          oauthConfig: {
            clientId: "id",
            authorizeUrl: "https://strava.com/auth",
            tokenUrl: "https://strava.com/token",
            redirectUri: "https://example.com/callback",
            scopes: ["read"],
          },
          exchangeCode: async () => ({
            accessToken: "t",
            refreshToken: null,
            expiresAt: new Date(),
            scopes: null,
          }),
          // No automatedLogin
        }),
      });
      mockGetAllProviders.mockReturnValue([provider]);
      mockEnsureProvidersRegistered.mockResolvedValue(undefined);

      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-abc",
        timezone: "UTC",
      });

      await expect(
        caller.signIn({ providerId: "strava", username: "a", password: "b" }),
      ).rejects.toThrow("does not support credential authentication");
    });

    it("propagates automatedLogin errors", async () => {
      const provider = stubProvider({
        id: "eight-sleep",
        name: "Eight Sleep",
        authSetup: () => ({
          oauthConfig: {
            clientId: "",
            authorizeUrl: "",
            tokenUrl: "",
            redirectUri: "",
            scopes: [],
          },
          exchangeCode: async () => {
            throw new Error("not supported");
          },
          automatedLogin: vi.fn().mockRejectedValue(new Error("Invalid credentials")),
        }),
      });
      mockGetAllProviders.mockReturnValue([provider]);
      mockEnsureProvidersRegistered.mockResolvedValue(undefined);

      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-abc",
        timezone: "UTC",
      });

      await expect(
        caller.signIn({ providerId: "eight-sleep", username: "bad", password: "wrong" }),
      ).rejects.toThrow("Invalid credentials");
    });

    it("throws when provider has no authSetup", async () => {
      const provider = stubProvider({ id: "no-auth", name: "No Auth" });
      mockGetAllProviders.mockReturnValue([provider]);
      mockEnsureProvidersRegistered.mockResolvedValue(undefined);

      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-abc",
        timezone: "UTC",
      });

      await expect(
        caller.signIn({ providerId: "no-auth", username: "a", password: "b" }),
      ).rejects.toThrow("does not support credential authentication");
    });
  });
});
