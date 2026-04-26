import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const { mockGet, mockSet, mockInvalidateByPrefix } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSet: vi.fn(),
  mockInvalidateByPrefix: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { LONG: 3_600_000 },
  };
});

vi.mock("../repositories/settings-repository.ts", () => ({
  SettingsRepository: vi.fn(() => ({
    get: mockGet,
    set: mockSet,
  })),
}));

vi.mock("../lib/cache.ts", () => ({
  queryCache: {
    invalidateByPrefix: mockInvalidateByPrefix,
  },
}));

import { PROVIDER_GUIDE_SETTINGS_KEY, providerGuideRouter } from "./provider-guide.ts";

describe("providerGuideRouter", () => {
  const createCaller = createTestCallerFactory(providerGuideRouter);

  beforeEach(() => {
    vi.clearAllMocks();
    mockInvalidateByPrefix.mockResolvedValue(undefined);
  });

  describe("status", () => {
    it("returns dismissed false when the guide has not been dismissed", async () => {
      mockGet.mockResolvedValue(null);
      const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

      const result = await caller.status();

      expect(result).toEqual({ dismissed: false });
      expect(mockGet).toHaveBeenCalledWith(PROVIDER_GUIDE_SETTINGS_KEY);
    });

    it("returns dismissed true when the guide dismissal setting is true", async () => {
      mockGet.mockResolvedValue({ key: PROVIDER_GUIDE_SETTINGS_KEY, value: true });
      const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

      const result = await caller.status();

      expect(result).toEqual({ dismissed: true });
    });
  });

  describe("dismiss", () => {
    it("stores the guide dismissal setting and invalidates provider guide cache", async () => {
      mockSet.mockResolvedValue({ key: PROVIDER_GUIDE_SETTINGS_KEY, value: true });
      const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

      const result = await caller.dismiss();

      expect(result).toEqual({ dismissed: true });
      expect(mockSet).toHaveBeenCalledWith(PROVIDER_GUIDE_SETTINGS_KEY, true);
      expect(mockInvalidateByPrefix).toHaveBeenCalledWith("user-1:providerGuide.");
    });
  });
});
