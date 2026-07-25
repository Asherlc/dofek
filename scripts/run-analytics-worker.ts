import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import * as Sentry from "@sentry/node";
import { z } from "zod";
import { AnalyticsWorker, createAnalyticsWorkerHealthServer } from "../src/analytics-worker.ts";
import { initProductionSentry } from "../src/lib/sentry.ts";
import { logger } from "../src/logger.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const durationSecondsSchema = z
  .string()
  .regex(/^\d+$/)
  .transform((value) => Number.parseInt(value, 10));

function durationMillisecondsFromEnvironment(name: string, fallbackSeconds: number): number {
  const rawValue = process.env[name] ?? String(fallbackSeconds);
  const parsed = durationSecondsSchema.safeParse(rawValue);
  if (!parsed.success) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(rawValue)}`);
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

export async function runAnalyticsWorker(): Promise<void> {
  const sentryDsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
  initProductionSentry(sentryDsn);

  const worker = new AnalyticsWorker({
    intervalMilliseconds: durationMillisecondsFromEnvironment(
      "ANALYTICS_BUILD_INTERVAL_SECONDS",
      900,
    ),
    retryDelayMilliseconds: durationMillisecondsFromEnvironment(
      "ANALYTICS_BUILD_RETRY_DELAY_SECONDS",
      300,
    ),
    startupDelayMilliseconds: durationMillisecondsFromEnvironment(
      "ANALYTICS_BUILD_STARTUP_DELAY_SECONDS",
      120,
    ),
    now: () => new Date(),
    reportFailure: (error, tags) => {
      Sentry.captureException(error, { tags });
      logger.error(
        `[analytics-worker] ${tags.analyticsRefreshStep} failed: ${errorMessage(error)}`,
      );
    },
    runAnalyticsBuild: async () => {
      const { runAnalyticsBuildFromEnvironment } = await import("./run-analytics-build.ts");
      await runAnalyticsBuildFromEnvironment();
    },
    sleep,
    warmQueryCache: async () => {
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
