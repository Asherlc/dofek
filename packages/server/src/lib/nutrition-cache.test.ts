import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  invalidateByPrefix: vi.fn().mockResolvedValue(undefined),
  warn: vi.fn(),
}));

vi.mock("@sentry/node", () => ({ captureException: mocks.captureException }));
vi.mock("dofek/lib/cache", () => ({
  queryCache: { invalidateByPrefix: mocks.invalidateByPrefix },
}));
vi.mock("../logger.ts", () => ({ logger: { warn: mocks.warn } }));

import { invalidateNutritionCaches } from "./nutrition-cache.ts";

describe("invalidateNutritionCaches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates food, nutrition, and nutrition analytics for one user", async () => {
    await invalidateNutritionCaches("user-1");

    expect(mocks.invalidateByPrefix.mock.calls).toEqual([
      ["user-1:food."],
      ["user-1:nutrition."],
      ["user-1:nutritionAnalytics."],
    ]);
  });
});
