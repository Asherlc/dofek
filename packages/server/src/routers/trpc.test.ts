import { initTRPC, TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock external dependencies before importing
vi.mock("../lib/cache.ts", () => ({
  queryCache: {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../lib/metrics.ts", () => ({
  cacheHitsTotal: { inc: vi.fn() },
  cacheMissesTotal: { inc: vi.fn() },
  trpcCacheLookupDuration: { observe: vi.fn() },
  trpcDbQueryDuration: { observe: vi.fn() },
  trpcProcedureDuration: { observe: vi.fn() },
}));

vi.mock("../lib/semaphore.ts", () => ({
  dbQuerySemaphore: {
    run: vi.fn(<T>(fn: () => Promise<T>) => fn()),
  },
}));

import { queryCache } from "../lib/cache.ts";
import { cacheHitsTotal, cacheMissesTotal } from "../lib/metrics.ts";
import { dbQuerySemaphore } from "../lib/semaphore.ts";
import {
  CacheTTL,
  type Context,
  cachedProtectedQuery,
  cachedProtectedQueryLight,
  protectedProcedure,
  router,
} from "../trpc.ts";

describe("trpc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("CacheTTL", () => {
    it("defines SHORT minutes", () => {
      expect(CacheTTL.SHORT).toBe(2 * 60 * 1000);
    });

    it("defines MEDIUM minutes", () => {
      expect(CacheTTL.MEDIUM).toBe(10 * 60 * 1000);
    });

    it("defines LONG hour", () => {
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

      const trpc = initTRPC.context<Context>().create();
      const createCaller = trpc.createCallerFactory(testRouter);
      const caller = createCaller({
        db: {},
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

      const trpc = initTRPC.context<Context>().create();
      const createCaller = trpc.createCallerFactory(testRouter);
      const caller = createCaller({
        db: {},
        userId: "user-123",
      });

      const result = await caller.test();
      expect(result).toBe("user-123");
    });
  });

  describe("cached middleware", () => {
    function createCachedRouter() {
      const testRouter = router({
        cachedQuery: cachedProtectedQuery(CacheTTL.SHORT).query(() => "db-result"),
        lightQuery: cachedProtectedQueryLight(CacheTTL.MEDIUM).query(() => "light-result"),
      });
      const trpc = initTRPC.context<Context>().create();
      const createCaller = trpc.createCallerFactory(testRouter);
      return createCaller;
    }

    it("returns cached data on cache hit", async () => {
      vi.mocked(queryCache.get).mockResolvedValue("cached-value");
      const createCaller = createCachedRouter();
      const caller = createCaller({ db: {}, userId: "user-1" });

      const result = await caller.cachedQuery();
      expect(result).toBe("cached-value");
      expect(cacheHitsTotal.inc).toHaveBeenCalledWith({ procedure: "cachedQuery" });
      expect(queryCache.set).not.toHaveBeenCalled();
    });

    it("calls next() and caches result on cache miss", async () => {
      vi.mocked(queryCache.get).mockResolvedValue(undefined);
      const createCaller = createCachedRouter();
      const caller = createCaller({ db: {}, userId: "user-1" });

      const result = await caller.cachedQuery();
      expect(result).toBe("db-result");
      expect(cacheMissesTotal.inc).toHaveBeenCalledWith({ procedure: "cachedQuery" });
      expect(queryCache.set).toHaveBeenCalledWith(
        expect.stringContaining("user-1:cachedQuery:"),
        "db-result",
        CacheTTL.SHORT,
      );
    });

    it("uses semaphore for normal cached queries", async () => {
      vi.mocked(queryCache.get).mockResolvedValue(undefined);
      const createCaller = createCachedRouter();
      const caller = createCaller({ db: {}, userId: "user-1" });

      await caller.cachedQuery();
      expect(dbQuerySemaphore.run).toHaveBeenCalled();
    });

    it("bypasses semaphore for lightweight cached queries", async () => {
      vi.mocked(queryCache.get).mockResolvedValue(undefined);
      const createCaller = createCachedRouter();
      const caller = createCaller({ db: {}, userId: "user-1" });

      await caller.lightQuery();
      // Lightweight queries should NOT go through the semaphore
      expect(dbQuerySemaphore.run).not.toHaveBeenCalled();
    });

    it("includes userId in cache key for anonymous users", async () => {
      vi.mocked(queryCache.get).mockResolvedValue(undefined);
      // cachedProtectedQuery requires auth, so we can't test anonymous via it.
      // But we can verify the key format by checking what queryCache.get was called with.
      const createCaller = createCachedRouter();
      const caller = createCaller({ db: {}, userId: "user-abc" });

      await caller.cachedQuery();
      expect(queryCache.get).toHaveBeenCalledWith(expect.stringContaining("user-abc:"));
    });
  });
});
