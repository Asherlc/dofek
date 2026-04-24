import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";
import { sql } from "drizzle-orm";
import { logger } from "../logger.ts";
import type { SyncDatabase } from "./index.ts";

type RefreshDatabase = Pick<SyncDatabase, "execute">;

export interface MaterializedViewRefreshOptions {
  source: string;
  fallbackToBlocking?: boolean;
}

export interface MaterializedViewRefreshResult {
  fallbackUsed: boolean;
  mode: "blocking" | "concurrent";
}

type RefreshMode = "blocking" | "concurrent";
type RefreshResult = "error" | "success";

const tracer = trace.getTracer("dofek-db", "1.0.0");
const meter = metrics.getMeter("dofek-db", "1.0.0");

const materializedViewRefreshTotal = meter.createCounter("db.materialized_view.refresh.total", {
  description: "Total number of materialized view refresh attempts",
  unit: "{attempts}",
});

const materializedViewRefreshDuration = meter.createHistogram(
  "db.materialized_view.refresh.duration",
  {
    description: "Duration of materialized view refresh attempts",
    unit: "ms",
    advice: {
      explicitBucketBoundaries: [50, 100, 250, 500, 1_000, 5_000, 15_000, 30_000, 60_000, 300_000],
    },
  },
);

function refreshSql(view: string, mode: RefreshMode): string {
  return mode === "concurrent"
    ? `REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`
    : `REFRESH MATERIALIZED VIEW ${view}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function attemptRefresh(
  db: RefreshDatabase,
  view: string,
  source: string,
  mode: RefreshMode,
): Promise<void> {
  const start = performance.now();
  let result: RefreshResult = "success";
  try {
    await db.execute(sql.raw(refreshSql(view, mode)));
  } catch (error) {
    result = "error";
    throw error;
  } finally {
    const durationMs = performance.now() - start;
    materializedViewRefreshTotal.add(1, { mode, result, source, view });
    materializedViewRefreshDuration.record(durationMs, { mode, result, source, view });
  }
}

export async function refreshMaterializedView(
  db: RefreshDatabase,
  view: string,
  options: MaterializedViewRefreshOptions,
): Promise<MaterializedViewRefreshResult> {
  const { source, fallbackToBlocking = true } = options;

  return tracer.startActiveSpan(
    "db.materialized_view.refresh",
    async (span): Promise<MaterializedViewRefreshResult> => {
      span.setAttributes({
        "db.materialized_view.name": view,
        "db.operation.name": "REFRESH MATERIALIZED VIEW",
        "db.system.name": "postgresql",
        "dofek.materialized_view.source": source,
      });
      try {
        await attemptRefresh(db, view, source, "concurrent");
        span.setAttributes({
          "dofek.materialized_view.fallback_used": false,
          "dofek.materialized_view.mode": "concurrent",
        });
        span.setStatus({ code: SpanStatusCode.OK });
        return { fallbackUsed: false, mode: "concurrent" };
      } catch (concurrentError) {
        span.addEvent("concurrent_refresh_failed", {
          "exception.message": errorMessage(concurrentError),
        });

        if (!fallbackToBlocking) {
          logger.error(
            `[mv-refresh] source=${source} view=${view} mode=concurrent result=error message=${errorMessage(concurrentError)}`,
          );
          span.recordException(
            concurrentError instanceof Error ? concurrentError : new Error(String(concurrentError)),
          );
          span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(concurrentError) });
          throw concurrentError;
        }

        logger.warn(
          `[mv-refresh] source=${source} view=${view} mode=concurrent result=error falling_back=true message=${errorMessage(concurrentError)}`,
        );

        try {
          await attemptRefresh(db, view, source, "blocking");
          span.setAttributes({
            "dofek.materialized_view.fallback_used": true,
            "dofek.materialized_view.mode": "blocking",
          });
          span.setStatus({ code: SpanStatusCode.OK });
          return { fallbackUsed: true, mode: "blocking" };
        } catch (blockingError) {
          const aggregateError = new AggregateError(
            [concurrentError, blockingError],
            `Failed to refresh ${view} (both CONCURRENT and blocking)`,
          );
          logger.error(
            `[mv-refresh] source=${source} view=${view} mode=blocking result=error message=${errorMessage(blockingError)}`,
          );
          span.recordException(aggregateError);
          span.setStatus({ code: SpanStatusCode.ERROR, message: aggregateError.message });
          throw aggregateError;
        }
      } finally {
        span.end();
      }
    },
  );
}
