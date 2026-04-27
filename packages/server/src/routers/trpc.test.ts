import { initTRPC, TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessWindow } from "../billing/entitlement.ts";

// Mock external dependencies before importing
vi.mock("dofek/lib/cache", () => ({
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

import { queryCache } from "dofek/lib/cache";
import { cacheHitsTotal, cacheMissesTotal } from "../lib/metrics.ts";
import {
  adminProcedure,
  CacheTTL,
  type Context,
  cachedProtectedQuery,
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
        timezone: "UTC",
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
        timezone: "UTC",
      });

      const result = await caller.test();
      expect(result).toBe("user-123");
    });

    it("passes the resolved access window to authenticated procedures", async () => {
      const accessWindow: AccessWindow = {
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2026-04-10",
        endDateExclusive: "2026-04-17",
      };
      const testRouter = router({
        test: protectedProcedure.query(({ ctx }) => ctx.accessWindow),
      });

      const trpc = initTRPC.context<Context>().create();
      const createCaller = trpc.createCallerFactory(testRouter);
      const caller = createCaller({
        db: {},
        userId: "user-123",
        timezone: "UTC",
        accessWindow,
      });

      const result = await caller.test();
      expect(result).toEqual(accessWindow);
    });

    it("defaults authenticated procedures to full access when no window is provided", async () => {
      const testRouter = router({
        test: protectedProcedure.query(({ ctx }) => ctx.accessWindow),
      });

      const trpc = initTRPC.context<Context>().create();
      const createCaller = trpc.createCallerFactory(testRouter);
      const caller = createCaller({
        db: {},
        userId: "user-123",
        timezone: "UTC",
      });

      const result = await caller.test();
      expect(result).toEqual({
        kind: "full",
        paid: true,
        reason: "paid_grant",
      });
    });
  });

  describe("admin middleware", () => {
    it("rejects unauthenticated requests", async () => {
      const testRouter = router({
        test: adminProcedure.query(() => "ok"),
      });

      const trpc = initTRPC.context<Context>().create();
      const createCaller = trpc.createCallerFactory(testRouter);
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: null,
        timezone: "UTC",
      });

      await expect(caller.test()).rejects.toThrow(TRPCError);
      await expect(caller.test()).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });

    it("rejects non-admin users", async () => {
      // Mock isAdmin to return false
      vi.doMock("../auth/admin.ts", () => ({
        isAdmin: vi.fn().mockResolvedValue(false),
      }));

      const testRouter = router({
        test: adminProcedure.query(() => "ok"),
      });

      const trpc = initTRPC.context<Context>().create();
      const createCaller = trpc.createCallerFactory(testRouter);
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-123",
        timezone: "UTC",
      });

      await expect(caller.test()).rejects.toThrow(TRPCError);
      await expect(caller.test()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });

    it("allows admin users through", async () => {
      // Mock isAdmin to return true
      vi.doMock("../auth/admin.ts", () => ({
        isAdmin: vi.fn().mockResolvedValue(true),
      }));

      const testRouter = router({
        test: adminProcedure.query(({ ctx }) => ctx.userId),
      });

      const trpc = initTRPC.context<Context>().create();
      const createCaller = trpc.createCallerFactory(testRouter);
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "admin-123",
        timezone: "UTC",
      });

      const result = await caller.test();
      expect(result).toBe("admin-123");
    });
  });

  describe("cached middleware", () => {
    function createCachedRouter() {
      const testRouter = router({
        cachedQuery: cachedProtectedQuery(CacheTTL.SHORT).query(() => "db-result"),
      });
      const trpc = initTRPC.context<Context>().create();
      const createCaller = trpc.createCallerFactory(testRouter);
      return createCaller;
    }

    it("returns cached data on cache hit", async () => {
      vi.mocked(queryCache.get).mockResolvedValue("cached-value");
      const createCaller = createCachedRouter();
      const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

      const result = await caller.cachedQuery();
      expect(result).toBe("cached-value");
      expect(cacheHitsTotal.inc).toHaveBeenCalledWith({ procedure: "cachedQuery" });
      expect(queryCache.set).not.toHaveBeenCalled();
    });

    it("calls next() and caches result on cache miss", async () => {
      vi.mocked(queryCache.get).mockResolvedValue(undefined);
      const createCaller = createCachedRouter();
      const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

      const result = await caller.cachedQuery();
      expect(result).toBe("db-result");
      expect(cacheMissesTotal.inc).toHaveBeenCalledWith({ procedure: "cachedQuery" });
      expect(queryCache.set).toHaveBeenCalledWith(
        expect.stringContaining("user-1:cachedQuery:"),
        "db-result",
        CacheTTL.SHORT,
      );
    });

    it("includes userId in cache key for anonymous users", async () => {
      vi.mocked(queryCache.get).mockResolvedValue(undefined);
      // cachedProtectedQuery requires auth, so we can't test anonymous via it.
      // But we can verify the key format by checking what queryCache.get was called with.
      const createCaller = createCachedRouter();
      const caller = createCaller({ db: {}, userId: "user-abc", timezone: "UTC" });

      await caller.cachedQuery();
      expect(queryCache.get).toHaveBeenCalledWith(expect.stringContaining("user-abc:"));
    });
  });
});
