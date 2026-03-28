import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string }>()
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

describe("stressRouter", () => {
  async function makeCaller(executeResult: unknown[] = []) {
    const execute = vi.fn().mockResolvedValue(executeResult);
    const { stressRouter } = await import("./stress.ts");
    const callerFactory = createTestCallerFactory(stressRouter);
    return {
      caller: callerFactory({ db: { execute }, userId: "user-1", timezone: "UTC" }),
      execute,
    };
  }

  describe("scores", () => {
    it("returns result from repository", async () => {
      const { caller } = await makeCaller([]);
      const result = await caller.scores({ endDate: "2026-03-28" });
      expect(result).toBeDefined();
    });

    it("uses default days (90) when not specified", async () => {
      const { caller, execute } = await makeCaller([]);
      await caller.scores({ endDate: "2026-03-28" });
      expect(execute).toHaveBeenCalled();
    });

    it("passes custom days to repository", async () => {
      const { caller, execute } = await makeCaller([]);
      await caller.scores({ days: 30, endDate: "2026-03-28" });
      expect(execute).toHaveBeenCalled();
    });
  });
});
