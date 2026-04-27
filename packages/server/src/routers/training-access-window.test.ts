import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone: string;
      accessWindow?: import("../billing/entitlement.ts").AccessWindow;
    }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(
      async (
        db: { execute: (q: unknown) => Promise<unknown[]> },
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: vi.fn().mockResolvedValue(null),
}));

import { trainingRouter } from "./training.ts";

const createCaller = createTestCallerFactory(trainingRouter);

describe("trainingRouter access window gating", () => {
  it("weeklyVolume passes accessWindow to repository (limited window returns empty)", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      accessWindow: {
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2026-04-10",
        endDateExclusive: "2026-04-17",
      },
    });
    const result = await caller.weeklyVolume({ days: 90 });
    expect(result).toEqual([]);
  });
});
