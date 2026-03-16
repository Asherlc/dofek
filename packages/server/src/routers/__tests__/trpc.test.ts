import { initTRPC, TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";

// Mock external dependencies before importing
vi.mock("../../lib/cache.ts", () => ({
  queryCache: {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../lib/metrics.ts", () => ({
  cacheHitsTotal: { inc: vi.fn() },
  cacheMissesTotal: { inc: vi.fn() },
  trpcCacheLookupDuration: { observe: vi.fn() },
  trpcDbQueryDuration: { observe: vi.fn() },
  trpcProcedureDuration: { observe: vi.fn() },
}));

vi.mock("../../lib/semaphore.ts", () => ({
  dbQuerySemaphore: {
    run: vi.fn(<T>(fn: () => Promise<T>) => fn()),
  },
}));

import {
  CacheTTL,
  type Context,
  cachedProtectedQuery,
  cachedProtectedQueryLight,
  protectedProcedure,
  router,
} from "../../trpc.ts";

describe("trpc", () => {
  describe("CacheTTL", () => {
    it("defines SHORT as 2 minutes", () => {
      expect(CacheTTL.SHORT).toBe(2 * 60 * 1000);
    });

    it("defines MEDIUM as 10 minutes", () => {
      expect(CacheTTL.MEDIUM).toBe(10 * 60 * 1000);
    });

    it("defines LONG as 1 hour", () => {
      expect(CacheTTL.LONG).toBe(60 * 60 * 1000);
    });
  });

  describe("exports", () => {
    it("exports router function", () => {
      expect(typeof router).toBe("function");
    });

    it("exports protectedProcedure", () => {
      expect(protectedProcedure).toBeDefined();
    });

    it("exports cachedProtectedQuery function", () => {
      expect(typeof cachedProtectedQuery).toBe("function");
    });

    it("exports cachedProtectedQueryLight function", () => {
      expect(typeof cachedProtectedQueryLight).toBe("function");
    });
  });

  describe("auth middleware", () => {
    it("rejects unauthenticated requests (userId is null)", async () => {
      const testRouter = router({
        test: protectedProcedure.query(() => "ok"),
      });

      const t = initTRPC.context<Context>().create();
      const createCaller = t.createCallerFactory(testRouter);
      const caller = createCaller({
        db: {} as Context["db"],
        userId: null,
      });

      await expect(caller.test()).rejects.toThrow(TRPCError);
      await expect(caller.test()).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });

    it("allows authenticated requests (userId is set)", async () => {
      const testRouter = router({
        test: protectedProcedure.query(({ ctx }) => ctx.userId),
      });

      const t = initTRPC.context<Context>().create();
      const createCaller = t.createCallerFactory(testRouter);
      const caller = createCaller({
        db: {} as Context["db"],
        userId: "user-123",
      });

      const result = await caller.test();
      expect(result).toBe("user-123");
    });
  });
});
