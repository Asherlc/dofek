import { describe, expect, it, vi } from "vitest";

const { mockSignIn, mockEnsureProvider, mockSaveTokens, mockInvalidateByPrefix } = vi.hoisted(
  () => ({
    mockSignIn: vi.fn(),
    mockEnsureProvider: vi.fn(),
    mockSaveTokens: vi.fn(),
    mockInvalidateByPrefix: vi.fn(),
  }),
);

vi.mock("garmin-connect", () => ({
  GarminConnectClient: { signIn: mockSignIn },
}));

vi.mock("dofek/db/tokens", () => ({
  ensureProvider: mockEnsureProvider,
  saveTokens: mockSaveTokens,
}));

vi.mock("../lib/cache.ts", () => ({
  queryCache: { invalidateByPrefix: mockInvalidateByPrefix },
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC.context<{ db: unknown; userId: string }>().create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
  };
});

import { garminAuthRouter } from "./garmin-auth.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

describe("garminAuthRouter", () => {
  const createCaller = createTestCallerFactory(garminAuthRouter);

  describe("signIn", () => {
    it("calls GarminConnectClient.signIn and saves tokens", async () => {
      const fakeTokens = {
        oauth1: { oauth_token: "t1", oauth_token_secret: "s1" },
        oauth2: { access_token: "a2", expires_in: 3600 },
      };
      mockSignIn.mockResolvedValue({ client: {}, tokens: fakeTokens });
      mockEnsureProvider.mockResolvedValue(undefined);
      mockSaveTokens.mockResolvedValue(undefined);
      mockInvalidateByPrefix.mockResolvedValue(undefined);

      const mockDb = { execute: vi.fn() };
      const caller = createCaller({ db: mockDb, userId: "user-123" });

      const result = await caller.signIn({
        username: "test@example.com",
        password: "secret",
      });

      expect(result.success).toBe(true);
      expect(mockSignIn).toHaveBeenCalledWith("test@example.com", "secret", "garmin.com");
      expect(mockEnsureProvider).toHaveBeenCalledWith(
        mockDb,
        "garmin",
        "Garmin Connect",
        undefined,
        "user-123",
      );
      expect(mockSaveTokens).toHaveBeenCalledWith(mockDb, "garmin", {
        accessToken: JSON.stringify(fakeTokens),
        refreshToken: null,
        expiresAt: expect.any(Date),
        scopes: "garmin-connect-internal",
      });
      expect(mockInvalidateByPrefix).toHaveBeenCalledWith("user-123:sync.providers");
    });

    it("propagates GarminConnectClient.signIn errors", async () => {
      mockSignIn.mockRejectedValue(new Error("Invalid credentials"));

      const caller = createCaller({ db: { execute: vi.fn() }, userId: "user-123" });

      await expect(
        caller.signIn({ username: "bad@example.com", password: "wrong" }),
      ).rejects.toThrow("Invalid credentials");
    });
  });
});
