import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import * as Sentry from "@sentry/node";
import { z } from "zod";
import { AnalyticsWorker, createAnalyticsWorkerHealthServer } from "../src/analytics-worker.ts";
import { captureException } from "../src/lib/error-reporting.ts";
import { initProductionSentry } from "../src/lib/sentry.ts";
import { logger } from "../src/logger.ts";
import { buildAnalyticsFailureCaptureContext } from "./analytics-error-context.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const durationSecondsSchema = z
  .string()
  .regex(/^\d+$/)
  .transform((value) => Number.parseInt(value, 10))
  .refine((value) => Number.isSafeInteger(value) && value <= 2_147_483);

function durationMillisecondsFromEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallbackSeconds: number,
): number {
  const rawValue = environment[name] ?? String(fallbackSeconds);
  const parsed = durationSecondsSchema.safeParse(rawValue);
  if (!parsed.success) {
    throw new Error(
      `${name} must be an integer from 0 through 2147483 seconds, got ${JSON.stringify(rawValue)}`,
    );
  }
  return parsed.data * 1_000;
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

interface AnalyticsWorkerDependencies {
  now(): Date;
  reportFailure(
    error: unknown,
    tags: { analyticsRefreshStep: "analytics-build" | "query-cache-warm" },
  ): void;
  runAnalyticsBuildFromEnvironment(): Promise<void>;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
  warmQueryCacheFromEnvironment(): Promise<void>;
}

export function createAnalyticsWorkerFromEnvironment(
  environment: NodeJS.ProcessEnv,
  dependencies: AnalyticsWorkerDependencies,
): AnalyticsWorker {
  return new AnalyticsWorker({
    intervalMilliseconds: durationMillisecondsFromEnvironment(
      environment,
      "ANALYTICS_BUILD_INTERVAL_SECONDS",
      900,
    ),
    retryDelayMilliseconds: durationMillisecondsFromEnvironment(
      environment,
      "ANALYTICS_BUILD_RETRY_DELAY_SECONDS",
      300,
    ),
    startupDelayMilliseconds: durationMillisecondsFromEnvironment(
      environment,
      "ANALYTICS_BUILD_STARTUP_DELAY_SECONDS",
      120,
    ),
    now: dependencies.now,
    reportFailure: dependencies.reportFailure,
    runAnalyticsBuild: dependencies.runAnalyticsBuildFromEnvironment,
    sleep: dependencies.sleep,
    warmQueryCache: dependencies.warmQueryCacheFromEnvironment,
  });
}

export async function runAnalyticsWorker(): Promise<void> {
  const sentryDsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
  initProductionSentry(sentryDsn);

  const worker = createAnalyticsWorkerFromEnvironment(process.env, {
    now: () => new Date(),
    reportFailure: (error, tags) => {
      captureException(error, buildAnalyticsFailureCaptureContext(error, tags));
      logger.error(
        `[analytics-worker] ${tags.analyticsRefreshStep} failed: ${errorMessage(error)}`,
      );
    },
    runAnalyticsBuildFromEnvironment: async () => {
      const { runAnalyticsBuildFromEnvironment } = await import("./run-analytics-build.ts");
      await runAnalyticsBuildFromEnvironment();
    },
    sleep,
    warmQueryCacheFromEnvironment: async () => {
      const { warmQueryCacheFromEnvironment } = await import("./warm-query-cache.ts");
      await warmQueryCacheFromEnvironment();
    },
  });
  const healthServer = createAnalyticsWorkerHealthServer(worker);
  await new Promise<void>((resolve) => healthServer.listen(3002, "127.0.0.1", resolve));
  logger.info("[analytics-worker] Readiness endpoint listening on http://127.0.0.1:3002/readyz");

  const abortController = new AbortController();
  const stop = () => abortController.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await worker.run(abortController.signal);
  } finally {
    await closeServer(healthServer);
    await Sentry.close(2_000);
  }
}

const scriptPath = process.argv[1];
if (scriptPath && import.meta.url === pathToFileURL(scriptPath).href) {
  await runAnalyticsWorker();
}
