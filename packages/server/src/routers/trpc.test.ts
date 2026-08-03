import { initTRPC, TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessWindow } from "../billing/entitlement.ts";

const { mockSpan, mockStartActiveSpan } = vi.hoisted(() => {
  const span = {
    end: vi.fn(),
    recordException: vi.fn(),
    setStatus: vi.fn(),
  };
  return {
    mockSpan: span,
    mockStartActiveSpan: vi.fn((_name, _options, callback) => callback(span)),
  };
});

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
  trpcSlowQueriesTotal: { inc: vi.fn() },
}));

vi.mock("../logger.ts", () => ({
  logger: { warn: vi.fn() },
}));

vi.mock("dofek/lib/error-reporting", () => ({
  captureException: vi.fn(),
}));

vi.mock("@opentelemetry/api", () => ({
  SpanStatusCode: { OK: 1, ERROR: 2 },
  trace: {
    getTracer: vi.fn(() => ({
      startActiveSpan: mockStartActiveSpan,
    })),
  },
}));

import { queryCache } from "dofek/lib/cache";
import { captureException } from "dofek/lib/error-reporting";
import {
  cacheHitsTotal,
  cacheMissesTotal,
  trpcCacheLookupDuration,
  trpcDbQueryDuration,
  trpcProcedureDuration,
  trpcSlowQueriesTotal,
} from "../lib/metrics.ts";
import { logger } from "../logger.ts";
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
    it("emits an OpenTelemetry span for tRPC procedures", async () => {
      const testRouter = router({
        test: protectedProcedure.query(() => "ok"),
      });

      const trpc = initTRPC.context<Context>().create();
      const createCaller = trpc.createCallerFactory(testRouter);
      const caller = createCaller({
        db: {},
        userId: "user-123",
        timezone: "UTC",
      });

      await expect(caller.test()).resolves.toBe("ok");

      expect(mockStartActiveSpan).toHaveBeenCalledWith(
        "trpc.procedure",
        {
          attributes: {
            "rpc.method": "test",
            "rpc.system": "trpc",
            "rpc.type": "query",
          },
        },
        expect.any(Function),
      );
      expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: 1 });
      expect(mockSpan.end).toHaveBeenCalledOnce();
    });

    it("marks failed tRPC procedure spans as errors", async () => {
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

      expect(mockStartActiveSpan).toHaveBeenCalledWith(
        "trpc.procedure",
        {
          attributes: {
            "rpc.method": "test",
            "rpc.system": "trpc",
            "rpc.type": "query",
          },
        },
        expect.any(Function),
      );
      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: 2,
        message: "Not authenticated",
      });
      expect(mockSpan.end).toHaveBeenCalledOnce();
    });

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

    it("passes the resolved access window to admin procedures", async () => {
      vi.doMock("../auth/admin.ts", () => ({
        isAdmin: vi.fn().mockResolvedValue(true),
      }));
      const accessWindow: AccessWindow = {
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2026-04-10",
        endDateExclusive: "2026-04-17",
      };
      const testRouter = router({
        test: adminProcedure.query(({ ctx }) => ({
          userId: ctx.userId,
          accessWindow: ctx.accessWindow,
        })),
      });

      const trpc = initTRPC.context<Context>().create();
      const createCaller = trpc.createCallerFactory(testRouter);
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "admin-123",
        timezone: "UTC",
        accessWindow,
      });

      await expect(caller.test()).resolves.toEqual({
        userId: "admin-123",
        accessWindow,
      });
    });
  });

  describe("infrastructure error sanitizer", () => {
    function createSanitizerCaller(error: unknown) {
      const testRouter = router({
        test: protectedProcedure.query(() => {
          throw error;
        }),
      });
      const trpc = initTRPC.context<Context>().create();
      const createCaller = trpc.createCallerFactory(testRouter);
      return createCaller({
        db: {},
        userId: "user-123",
        timezone: "UTC",
      });
    }

    const analyticsUnavailableMessage =
      "Analytics data is temporarily unavailable. Please retry in a minute.";

    async function expectSanitizedClickHouseError(error: unknown, reportableError = error) {
      const caller = createSanitizerCaller(error);

      await expect(caller.test()).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        message: analyticsUnavailableMessage,
      });
      expect(captureException).toHaveBeenCalledWith(reportableError, {
        tags: { dependency: "clickhouse", trpcPath: "test" },
      });
    }

    async function expectUnsanitizedError(error: unknown, message: string) {
      const caller = createSanitizerCaller(error);

      await expect(caller.test()).rejects.toMatchObject({ message });
      expect(captureException).not.toHaveBeenCalled();
    }

    it("hides ClickHouse DNS failures from tRPC callers and reports the original error", async () => {
      const internalError = Object.assign(new Error("getaddrinfo ENOTFOUND clickhouse"), {
        code: "ENOTFOUND",
      });

      await expectSanitizedClickHouseError(internalError);
    });

    it("does not sanitize non-ClickHouse errors", async () => {
      const databaseError = new Error("database connection timeout");

      await expectUnsanitizedError(databaseError, "database connection timeout");
    });

    it("hides ClickHouse connection refused errors from tRPC callers", async () => {
      const internalError = Object.assign(new Error("connect ECONNREFUSED clickhouse:8123"), {
        code: "ECONNREFUSED",
      });

      await expectSanitizedClickHouseError(internalError);
    });

    it("hides ClickHouse timeout errors detected by error code and message", async () => {
      const internalError = Object.assign(new Error("query failed against clickhouse backend"), {
        code: "ETIMEDOUT",
      });

      await expectSanitizedClickHouseError(internalError);
    });

    it("hides ClickHouse timeout errors detected by message text", async () => {
      const internalError = new Error("ClickHouse timeout error while executing query");

      await expectSanitizedClickHouseError(internalError);
    });

    it("hides missing analytics-store configuration from tRPC callers", async () => {
      const internalError = new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message:
          "Activity calendar requires the ClickHouse activity analytics store. Set CLICKHOUSE_URL and retry.",
      });

      await expectSanitizedClickHouseError(internalError);
    });

    it("does not hide timeout errors when the message is not from ClickHouse", async () => {
      const timeoutError = Object.assign(new Error("postgres request timed out"), {
        code: "ETIMEDOUT",
      });

      await expectUnsanitizedError(timeoutError, "postgres request timed out");
    });

    it("does not hide ClickHouse-labeled errors with unrelated error codes", async () => {
      const unrelatedCodeError = Object.assign(new Error("clickhouse background task failed"), {
        code: "ECONNRESET",
      });

      await expectUnsanitizedError(unrelatedCodeError, "clickhouse background task failed");
    });

    it("does not treat non-string error codes as ClickHouse infrastructure failures", async () => {
      const numericCodeError = Object.assign(new Error("clickhouse background task failed"), {
        code: 500,
      });

      await expectUnsanitizedError(numericCodeError, "clickhouse background task failed");
    });

    it("hides nested ClickHouse infrastructure causes and reports the root cause", async () => {
      const internalError = Object.assign(new Error("request failed for clickhouse backend"), {
        code: "ETIMEDOUT",
      });
      const wrappedError = new Error("analytics query failed", { cause: internalError });

      await expectSanitizedClickHouseError(wrappedError, internalError);
    });

    it("hides string ClickHouse DNS errors", async () => {
      await expectSanitizedClickHouseError(
        "getaddrinfo ENOTFOUND clickhouse",
        expect.objectContaining({ message: "getaddrinfo ENOTFOUND clickhouse" }),
      );
    });

    it("hides ClickHouse connection refused messages without relying on error code", async () => {
      const internalError = new Error("connect ECONNREFUSED 127.0.0.1 clickhouse");

      await expectSanitizedClickHouseError(internalError);
    });

    it("does not hide connection refused messages for other dependencies", async () => {
      const connectionError = new Error("connect ECONNREFUSED postgres:5432");

      await expectUnsanitizedError(connectionError, "connect ECONNREFUSED postgres:5432");
    });

    it("hides ClickHouse memory-limit errors", async () => {
      const internalError = new Error("ClickHouse query failed: memory limit exceeded");

      await expectSanitizedClickHouseError(internalError);
    });

    it("does not hide memory-limit errors for other dependencies", async () => {
      const memoryError = new Error("postgres query failed: memory limit exceeded");

      await expectUnsanitizedError(memoryError, "postgres query failed: memory limit exceeded");
    });

    it("hides ClickHouse overcommit tracker errors from tRPC callers", async () => {
      const internalError = new Error("OvercommitTracker decision: memory limit exceeded");

      await expectSanitizedClickHouseError(internalError);
    });
  });

  describe("cached middleware", () => {
    function createCachedRouter() {
      const testRouter = router({
        cachedQuery: cachedProtectedQuery({ maxAge: CacheTTL.SHORT }).query(() => "db-result"),
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

    it("records cache lookup metrics with a hit label", async () => {
      vi.mocked(queryCache.get).mockResolvedValue("cached-value");
      const nowSpy = vi
        .spyOn(performance, "now")
        .mockReturnValueOnce(1000)
        .mockReturnValueOnce(1010)
        .mockReturnValueOnce(1040)
        .mockReturnValueOnce(1050);
      const createCaller = createCachedRouter();
      const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

      await expect(caller.cachedQuery()).resolves.toBe("cached-value");

      expect(trpcCacheLookupDuration.observe).toHaveBeenCalledWith(
        { procedure: "cachedQuery", hit: "true" },
        0.03,
      );

      nowSpy.mockRestore();
    });

    it("records cache-hit procedure metrics with expected labels and seconds", async () => {
      vi.mocked(queryCache.get).mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return "cached-value";
      });
      const createCaller = createCachedRouter();
      const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });
      const startedAt = performance.now();

      await expect(caller.cachedQuery()).resolves.toBe("cached-value");
      const finishedAt = performance.now();

      expect(trpcProcedureDuration.observe).toHaveBeenCalledWith(
        { procedure: "cachedQuery", type: "query", cache_hit: "true" },
        expect.any(Number),
      );
      const observedSeconds = vi.mocked(trpcProcedureDuration.observe).mock.calls[0]?.[1];
      expect(observedSeconds).toBeGreaterThan(0.02);
      expect(observedSeconds).toBeLessThan(0.2);
      expect(observedSeconds).toBeCloseTo((finishedAt - startedAt) / 1000, 1);
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

    it("recomputes and overwrites successful results in cache refresh mode", async () => {
      vi.mocked(queryCache.get).mockResolvedValue("stale-value");
      const createCaller = createCachedRouter();
      const caller = createCaller({
        db: {},
        userId: "user-1",
        timezone: "UTC",
        cacheMode: "refresh",
      });

      await expect(caller.cachedQuery()).resolves.toBe("db-result");
      expect(queryCache.get).not.toHaveBeenCalled();
      expect(cacheMissesTotal.inc).not.toHaveBeenCalled();
      expect(queryCache.set).toHaveBeenCalledWith(
        expect.stringContaining("user-1:cachedQuery:"),
        "db-result",
        CacheTTL.SHORT,
      );
    });

    it("records cache miss lookup and database duration metrics with labels", async () => {
      vi.mocked(queryCache.get).mockResolvedValue(undefined);
      const nowSpy = vi
        .spyOn(performance, "now")
        .mockReturnValueOnce(1000)
        .mockReturnValueOnce(1010)
        .mockReturnValueOnce(1040)
        .mockReturnValueOnce(1050)
        .mockReturnValueOnce(1090)
        .mockReturnValueOnce(1110);
      const createCaller = createCachedRouter();
      const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

      await expect(caller.cachedQuery()).resolves.toBe("db-result");

      expect(trpcCacheLookupDuration.observe).toHaveBeenCalledWith(
        { procedure: "cachedQuery", hit: "false" },
        0.03,
      );
      expect(trpcDbQueryDuration.observe).toHaveBeenCalledWith({ procedure: "cachedQuery" }, 0.04);
      expect(trpcProcedureDuration.observe).toHaveBeenCalledWith(
        { procedure: "cachedQuery", type: "query", cache_hit: "false" },
        0.11,
      );

      nowSpy.mockRestore();
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

    it("logs slow uncached procedures with anon and unknown fallbacks", async () => {
      vi.mocked(queryCache.get).mockResolvedValue(undefined);
      const nowSpy = vi
        .spyOn(performance, "now")
        .mockReturnValueOnce(1000)
        .mockReturnValueOnce(1010)
        .mockReturnValueOnce(1020)
        .mockReturnValueOnce(1030)
        .mockReturnValueOnce(1735)
        .mockReturnValueOnce(1750);
      const testRouter = router({
        cachedQuery: cachedProtectedQuery({ maxAge: CacheTTL.SHORT }).query(() => "db-result"),
      });
      const trpc = initTRPC.context<Context>().create();
      const createCaller = trpc.createCallerFactory(testRouter);
      const caller = createCaller({
        db: {},
        userId: "user-1",
        timezone: "UTC",
        appVersion: undefined,
        assetsVersion: undefined,
      });

      await expect(caller.cachedQuery()).resolves.toBe("db-result");

      expect(trpcSlowQueriesTotal.inc).toHaveBeenCalledWith({
        procedure: "cachedQuery",
        type: "query",
      });
      expect(logger.warn).toHaveBeenCalledWith(
        "[trpc] Slow query procedure=cachedQuery type=query authenticated=true db_duration_ms=705 total_duration_ms=750 cache_hit=false app_version=unknown assets_version=unknown",
      );
      expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("user-1");

      nowSpy.mockRestore();
    });
  });
});
