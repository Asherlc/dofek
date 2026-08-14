// cspell:ignore overcommittracker
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { initTRPC, TRPCError } from "@trpc/server";
import { middlewareMarker } from "@trpc/server/unstable-core-do-not-import";
import type { Database } from "dofek/db";
import { queryCache } from "dofek/lib/cache";
import { captureException } from "dofek/lib/error-reporting";
import type { AccountErasureRestoreLedger } from "../../../src/account-erasure/restore-ledger.ts";
import type { MetricStreamEventPublisher } from "../../../src/metric-stream/redpanda-producer.ts";
import type { AccessWindow } from "./billing/entitlement.ts";
import {
  cacheHitsTotal,
  cacheMissesTotal,
  trpcCacheLookupDuration,
  trpcDbQueryDuration,
  trpcProcedureDuration,
  trpcSlowQueriesTotal,
} from "./lib/metrics.ts";
import { logger } from "./logger.ts";
import type { ActivitySensorStore } from "./repositories/activity-repository.ts";

export interface Context {
  accountErasureRestoreLedger: AccountErasureRestoreLedger;
  db: Database;
  sensorStore: ActivitySensorStore;
  metricStreamPublisher?: MetricStreamEventPublisher;
  userId: string | null;
  /** IANA timezone from client (e.g. "America/Los_Angeles"). Falls back to "UTC". */
  timezone: string;
  /** Client app semantic version, if provided (e.g. "1.2.3"). */
  appVersion?: string;
  /** Client asset/update identifier, if provided (e.g. Expo updateId). */
  assetsVersion?: string;
  /** Time this login session was created; destructive account changes require it to be recent. */
  authenticatedAt?: Date;
  /** Billing-derived read access window for authenticated users. */
  accessWindow?: AccessWindow;
  /** Internal cache warmer mode: recompute and overwrite without reading the current value. */
  cacheMode?: "refresh";
}

/** Context after auth middleware — userId is guaranteed non-null. */
export interface AuthenticatedContext extends Context {
  userId: string;
  accessWindow: AccessWindow;
}

const fullAccessWindow: AccessWindow = { kind: "full", paid: true, reason: "paid_grant" };

const UNEXPECTED_SERVER_ERROR_MESSAGE =
  "We couldn't complete this request. Please try again. If the problem continues, contact support.";

function shouldSanitizeInternalError(error: TRPCError): boolean {
  if (error.code !== "INTERNAL_SERVER_ERROR") return false;
  // tRPC copies an unknown cause's message onto its wrapper. An explicitly authored
  // client-safe TRPCError instead has a distinct actionable message, which we preserve.
  return error.message === error.code || error.message === error.cause?.message;
}

const trpc = initTRPC.context<Context>().create({
  errorFormatter({ error, shape }) {
    if (!shouldSanitizeInternalError(error)) return shape;

    const data = { ...shape.data };
    delete data.stack;
    return {
      ...shape,
      message: UNEXPECTED_SERVER_ERROR_MESSAGE,
      data,
    };
  },
});
const tracer = trace.getTracer("dofek-server");
const ANALYTICS_UNAVAILABLE_MESSAGE =
  "Analytics data is temporarily unavailable. Please retry in a minute.";

export const router = trpc.router;

function errorMessages(error: unknown): string[] {
  if (typeof error === "string") return [error];
  if (!(error instanceof Error)) return [];
  return [error.message, ...errorMessages(error.cause)];
}

function errorCodes(error: unknown): string[] {
  if (!(error instanceof Error)) return [];
  const currentCode = "code" in error && typeof error.code === "string" ? [error.code] : [];
  return [...currentCode, ...errorCodes(error.cause)];
}

function isClickHouseInfrastructureError(error: unknown): boolean {
  const messages = errorMessages(error).map((message) => message.toLowerCase());
  const codes = new Set(errorCodes(error));

  if (
    (codes.has("ENOTFOUND") || codes.has("ECONNREFUSED") || codes.has("ETIMEDOUT")) &&
    messages.some((message) => message.includes("clickhouse"))
  ) {
    return true;
  }

  return messages.some(
    (message) =>
      message.includes("getaddrinfo enotfound clickhouse") ||
      (message.includes("connect econnrefused") && message.includes("clickhouse")) ||
      message.includes("overcommittracker") ||
      (message.includes("clickhouse") &&
        (message.includes(" requires ") || message.includes(" required "))) ||
      (message.includes("clickhouse") && message.includes("memory limit exceeded")) ||
      (message.includes("clickhouse") && message.includes("timeout")),
  );
}

function reportableInfrastructureError(error: unknown): unknown {
  if (error instanceof Error && isClickHouseInfrastructureError(error.cause)) {
    return reportableInfrastructureError(error.cause);
  }
  return error;
}

function reportClickHouseInfrastructureError(error: unknown, path: string): void {
  captureException(reportableInfrastructureError(error), {
    tags: { dependency: "clickhouse", trpcPath: path },
  });
}

const sanitizeInfrastructureErrors = trpc.middleware(async ({ path, next }) => {
  try {
    const result = await next();
    if (!result.ok && isClickHouseInfrastructureError(result.error)) {
      reportClickHouseInfrastructureError(result.error, path);
      throw new TRPCError({
        code: "SERVICE_UNAVAILABLE",
        message: ANALYTICS_UNAVAILABLE_MESSAGE,
        cause: result.error,
      });
    }
    return result;
  } catch (error) {
    if (
      error instanceof TRPCError &&
      error.code === "SERVICE_UNAVAILABLE" &&
      error.message === ANALYTICS_UNAVAILABLE_MESSAGE
    ) {
      throw error;
    }
    if (isClickHouseInfrastructureError(error)) {
      reportClickHouseInfrastructureError(error, path);
      throw new TRPCError({
        code: "SERVICE_UNAVAILABLE",
        message: ANALYTICS_UNAVAILABLE_MESSAGE,
        cause: error,
      });
    }
    throw error;
  }
});

const traceProcedure = trpc.middleware(async ({ path, type, next }) =>
  tracer.startActiveSpan(
    "trpc.procedure",
    {
      attributes: {
        "rpc.method": path,
        "rpc.system": "trpc",
        "rpc.type": type,
      },
    },
    async (span) => {
      try {
        const result = await next();
        if (result.ok) {
          span.setStatus({ code: SpanStatusCode.OK });
        } else {
          span.setStatus({ code: SpanStatusCode.ERROR, message: result.error.message });
        }
        return result;
      } catch (error) {
        if (error instanceof Error) {
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        } else {
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
        }
        throw error;
      } finally {
        span.end();
      }
    },
  ),
);

const procedure = trpc.procedure.use(traceProcedure).use(sanitizeInfrastructureErrors);

// Auth middleware — rejects unauthenticated requests
const isAuthenticated = trpc.middleware(({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
  }
  const authenticatedCtx: AuthenticatedContext = {
    ...ctx,
    userId: ctx.userId,
    accessWindow: ctx.accessWindow ?? fullAccessWindow,
  };
  return next({ ctx: authenticatedCtx });
});

export const publicProcedure = procedure;
export const protectedProcedure = procedure.use(isAuthenticated);

// Admin middleware — requires authenticated user with is_admin flag
const isAdminUser = trpc.middleware(async ({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
  }
  const { isAdmin } = await import("./auth/admin.ts");
  const admin = await isAdmin(ctx.db, ctx.userId);
  if (!admin) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  }
  const authenticatedCtx: AuthenticatedContext = {
    ...ctx,
    userId: ctx.userId,
    accessWindow: ctx.accessWindow ?? fullAccessWindow,
  };
  return next({ ctx: authenticatedCtx });
});

export const adminProcedure = procedure.use(isAdminUser);

export const CacheTTL = {
  SHORT: 2 * 60 * 1000, // 2 min
  MEDIUM: 10 * 60 * 1000, // 10 min
  LONG: 60 * 60 * 1000, // 1 hour
} as const;

type CacheExpiry = "localDayBoundary";

interface CachePolicy {
  maxAge: number;
  expiresAt?: CacheExpiry;
  keyVersion?: string;
}

function localDateString(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return date.toISOString().slice(0, 10);
  return `${year}-${month}-${day}`;
}

function millisecondsUntilNextLocalDay(now: Date, timezone: string): number {
  const currentDate = localDateString(now, timezone);
  const nowMs = now.getTime();
  let lowerMs = nowMs;
  let upperMs = nowMs + 48 * 60 * 60 * 1000;

  while (upperMs - lowerMs > 1000) {
    const midpointMs = Math.floor((lowerMs + upperMs) / 2);
    if (localDateString(new Date(midpointMs), timezone) === currentDate) {
      lowerMs = midpointMs;
    } else {
      upperMs = midpointMs;
    }
  }

  return Math.max(1000, upperMs - nowMs);
}

export function requestCacheTtl(policy: CachePolicy, timezone: string, now = new Date()): number {
  if (policy.expiresAt !== "localDayBoundary") return policy.maxAge;

  try {
    return Math.min(policy.maxAge, millisecondsUntilNextLocalDay(now, timezone));
  } catch (error) {
    if (error instanceof RangeError) return policy.maxAge;
    throw error;
  }
}

export function requestCacheKey(
  userId: string | null,
  path: string,
  rawInput: unknown,
  timezone: string,
  keyVersion?: string,
): string {
  const versionSegment = keyVersion === undefined ? "" : `${keyVersion}:`;
  return `${userId ?? "anon"}:${path}:${versionSegment}${timezone}:${JSON.stringify(rawInput)}`;
}

function cached(policy: CachePolicy) {
  return trpc.middleware(async ({ ctx, path, type, getRawInput, next }) => {
    const start = performance.now();
    const rawInput = await getRawInput();
    // Include userId in cache key to prevent cross-user data leaks
    const key = requestCacheKey(ctx.userId, path, rawInput, ctx.timezone, policy.keyVersion);

    // Cache lookup
    const cacheLookupStart = performance.now();
    const hit = ctx.cacheMode === "refresh" ? undefined : await queryCache.get(key);
    trpcCacheLookupDuration.observe(
      { procedure: path, hit: hit !== undefined ? "true" : "false" },
      (performance.now() - cacheLookupStart) / 1000,
    );

    if (hit !== undefined) {
      cacheHitsTotal.inc({ procedure: path });
      trpcProcedureDuration.observe(
        { procedure: path, type, cache_hit: "true" },
        (performance.now() - start) / 1000,
      );
      return { ok: true as const, data: hit, marker: middlewareMarker };
    }

    if (ctx.cacheMode !== "refresh") {
      cacheMissesTotal.inc({ procedure: path });
    }

    const dbStart = performance.now();
    const result = await next();
    const dbDurationMs = performance.now() - dbStart;
    const totalDurationMs = performance.now() - start;
    trpcDbQueryDuration.observe({ procedure: path }, dbDurationMs / 1000);

    if (dbDurationMs > 500) {
      trpcSlowQueriesTotal.inc({ procedure: path, type });
      logger.warn(
        `[trpc] Slow query procedure=${path} type=${type} authenticated=${ctx.userId !== null} db_duration_ms=${Math.round(dbDurationMs)} total_duration_ms=${Math.round(totalDurationMs)} cache_hit=false app_version=${ctx.appVersion ?? "unknown"} assets_version=${ctx.assetsVersion ?? "unknown"}`,
      );
    }

    trpcProcedureDuration.observe(
      { procedure: path, type, cache_hit: "false" },
      totalDurationMs / 1000,
    );
    if (result.ok) {
      await queryCache.set(key, result.data, requestCacheTtl(policy, ctx.timezone));
    }
    return result;
  });
}

/** Cached protected query (requires auth, cache scoped by userId). */
export const cachedProtectedQuery = (policy: CachePolicy) => protectedProcedure.use(cached(policy));
