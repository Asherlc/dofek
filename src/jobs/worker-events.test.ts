import "./worker-test/test-helpers.ts";
import {
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { describe, expect, it, vi } from "vitest";
import {
  APPLE_HEALTH_IMPORT_VALIDATION_ERROR_NAME,
  STRONG_CSV_IMPORT_VALIDATION_ERROR_NAME,
} from "./import-validation-error.ts";
import { attachWorkerEvents } from "./worker-events.ts";
import { createWorkerLifecycle } from "./worker-lifecycle.ts";
import { createWorkerQueues } from "./worker-queues.ts";
import {
  getFitWorkerFailedHandler,
  getProviderDataDeletionRedriveHandler,
  getQueueWorkerHandler,
  getWorkerFailedHandler,
  getWorkerHandler,
  hoisted,
  mockAddJobLog,
  setTimeoutSpy,
  workerLifecycleDependencies,
  workerQueueDependencies,
} from "./worker-test/test-helpers.ts";

const dependencies = await workerQueueDependencies();
const queues = createWorkerQueues(dependencies);
const lifecycle = createWorkerLifecycle(await workerLifecycleDependencies(queues, dependencies));
attachWorkerEvents(
  queues.allWorkers,
  lifecycle,
  dependencies.db,
  queues.providerDataDeletionWorker,
);
lifecycle.startIdleTimer();

describe("worker events", () => {
  it("failed event handler reports to Sentry and logs the error", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();

    getWorkerHandler("active")();
    const error = new Error("test failure");
    const setTimeoutBefore = setTimeoutSpy.mock.calls.length;
    getWorkerHandler("failed")(undefined, error);

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
    expect(logger.error).toHaveBeenCalledWith("[worker] Job failed: test failure");
    expect(setTimeoutSpy.mock.calls.length).toBeGreaterThan(setTimeoutBefore);
  });

  it("failed event handler appends the detailed cause to the BullMQ job log", async () => {
    mockAddJobLog.mockClear();
    mockAddJobLog.mockResolvedValue(1);
    const failedJob = { attemptsMade: 1, opts: {}, id: "failed-fit-1" };

    getWorkerHandler("failed")(failedJob, new Error("invalid timestamp in activity.fit"));
    await vi.waitFor(() => {
      expect(mockAddJobLog).toHaveBeenCalledWith(
        expect.objectContaining({ name: "sync-strava" }),
        "failed-fit-1",
        "[error] BullMQ job failed: queue=sync-strava jobId=failed-fit-1 cause=invalid timestamp in activity.fit",
        100,
      );
    });
  });

  it("sanitizes account erasure job failures across Sentry, logs, and BullMQ", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    const privateRequestId = "10000000-0000-4000-8000-000000001994";
    const privateFailure = new Error("Processor rejected private@example.com");
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();
    mockAddJobLog.mockClear();

    getQueueWorkerHandler("account-erasure-queue", "failed")(
      { id: privateRequestId },
      privateFailure,
    );

    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Account erasure job failed",
      }),
      {
        tags: {
          bullmqEvent: "failed",
          queue: "account-erasure-queue",
        },
      },
    );
    expect(logger.error).toHaveBeenCalledWith("[worker] Account erasure job failed");
    expect(mockAddJobLog).not.toHaveBeenCalled();
    const capturedMessages = vi
      .mocked(Sentry.captureException)
      .mock.calls.map(([error]) => (error instanceof Error ? error.message : String(error)))
      .join("\n");
    const loggedMessages = vi.mocked(logger.error).mock.calls.flat().map(String).join("\n");
    expect(`${capturedMessages}\n${loggedMessages}`).not.toContain(privateRequestId);
    expect(`${capturedMessages}\n${loggedMessages}`).not.toContain("private@example.com");
  });

  it("sanitizes account erasure stalled, lock, and worker errors", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    const privateRequestId = "20000000-0000-4000-8000-000000001994";
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();
    mockAddJobLog.mockClear();

    getQueueWorkerHandler("account-erasure-queue", "stalled")(privateRequestId, "active");
    getQueueWorkerHandler("account-erasure-queue", "lockRenewalFailed")([privateRequestId]);
    getQueueWorkerHandler(
      "account-erasure-queue",
      "error",
    )(new Error("Redis rejected private@example.com"));

    const capturedMessages = vi
      .mocked(Sentry.captureException)
      .mock.calls.map(([error]) => (error instanceof Error ? error.message : String(error)));
    expect(capturedMessages).toEqual([
      "Account erasure BullMQ job stalled",
      "Account erasure BullMQ lock renewal failed",
      "Account erasure worker error",
    ]);
    expect(vi.mocked(logger.error).mock.calls).toEqual([
      ["[worker] Account erasure BullMQ job stalled"],
      ["[worker] Account erasure BullMQ lock renewal failed"],
      ["[worker] Account erasure worker error"],
    ]);
    expect(mockAddJobLog).not.toHaveBeenCalled();
    expect(capturedMessages.join("\n")).not.toContain(privateRequestId);
    expect(capturedMessages.join("\n")).not.toContain("private@example.com");
  });

  it("reports a failed-event BullMQ job-log write failure", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    const logError = new Error("job log Redis unavailable");
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();
    mockAddJobLog.mockRejectedValueOnce(logError);

    getWorkerHandler("failed")(
      { attemptsMade: 1, opts: {}, id: "failed-fit-log-1" },
      new Error("invalid FIT"),
    );

    await vi.waitFor(() => {
      expect(Sentry.captureException).toHaveBeenCalledWith(logError, {
        tags: { bullmqEvent: "failed", queue: "sync-strava" },
        extra: { jobId: "failed-fit-log-1", operation: "addJobLog" },
      });
    });
    expect(logger.error).toHaveBeenCalledWith(
      "[worker] Failed to append failed job log: queue=sync-strava jobId=failed-fit-log-1: Error: job log Redis unavailable",
    );
  });

  it.each([1, 287])(
    "logs Zepp HTTP500 attempt %s as retrying without Sentry capture",
    async (attemptsMade) => {
      const Sentry = await import("@sentry/node");
      const { logger } = await import("../logger.ts");
      vi.mocked(Sentry.captureException).mockClear();
      vi.mocked(logger.warn).mockClear();

      getWorkerHandler("active")();
      const error = new ProviderServiceUnavailableError({
        message: "Zepp API service unavailable (500): upstream outage",
        providerId: "amazfit-zepp",
        statusCode: 500,
        responseBody: "upstream outage",
      });
      getWorkerHandler("failed")({ attemptsMade, opts: { attempts: 288 } }, error);

      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        "[worker] Job retrying after provider service unavailable: Zepp API service unavailable (500): upstream outage",
      );
    },
  );

  it.each([
    undefined,
    { attemptsMade: 288, opts: { attempts: 288 } },
    { attemptsMade: 1, opts: {} },
    { attemptsMade: 1, opts: { attempts: 1 } },
  ])("reports terminal Zepp HTTP500 with job metadata %j", async (job) => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();
    vi.mocked(logger.warn).mockClear();
    const error = new ProviderServiceUnavailableError({
      providerId: "amazfit-zepp",
      statusCode: 500,
      message: "Zepp unavailable",
      responseBody: "outage",
    });
    getWorkerHandler("failed")(job, error);
    expect(Sentry.captureException).toHaveBeenCalledExactlyOnceWith(error);
    expect(logger.error).toHaveBeenCalledWith(`[worker] Job failed: ${error.message}`);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([504, "timeout"])(
    "keeps retrying OpenBeta %s observable without Sentry alerts",
    async (status) => {
      const Sentry = await import("@sentry/node");
      const { logger } = await import("../logger.ts");
      vi.mocked(Sentry.captureException).mockClear();
      vi.mocked(logger.warn).mockClear();
      const error =
        status === "timeout"
          ? new ProviderRequestTimeoutError({ providerId: "openbeta", timeoutMs: 120_000 })
          : new ProviderServiceUnavailableError({
              providerId: "openbeta",
              statusCode: 504,
              message: "upstream timeout",
              responseBody: "timeout",
            });

      getWorkerHandler("failed")({ attemptsMade: 1, opts: { attempts: 288 } }, error);

      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("retrying"));
    },
  );

  it("reports exhausted OpenBeta retries to Sentry", async () => {
    const Sentry = await import("@sentry/node");
    vi.mocked(Sentry.captureException).mockClear();
    const error = new ProviderServiceUnavailableError({
      providerId: "openbeta",
      statusCode: 504,
      message: "upstream timeout",
      responseBody: "timeout",
    });

    getWorkerHandler("failed")({ attemptsMade: 288, opts: { attempts: 288 } }, error);

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });

  it.each([undefined, { attemptsMade: 0, opts: {} }])(
    "reports OpenBeta failures when retry eligibility cannot be established: %j",
    async (job) => {
      const Sentry = await import("@sentry/node");
      const { logger } = await import("../logger.ts");
      vi.mocked(Sentry.captureException).mockClear();
      vi.mocked(logger.error).mockClear();
      const error = new ProviderRequestTimeoutError({ providerId: "openbeta", timeoutMs: 120_000 });
      // Without a job there is no retry policy; an absent attempts option means one attempt.
      if (job) job.attemptsMade = 1;
      getWorkerHandler("failed")(job, error);
      expect(Sentry.captureException).toHaveBeenCalledWith(error);
      expect(logger.error).toHaveBeenCalledWith(`[worker] Job failed: ${error.message}`);
    },
  );

  it("failed event handler reports unrelated provider service-unavailable errors", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    const error = new ProviderServiceUnavailableError({
      message: "Zwift API service unavailable (503): upstream outage",
      providerId: "zwift",
      statusCode: 503,
      responseBody: "upstream outage",
    });
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();

    getWorkerHandler("failed")(undefined, error);

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
    expect(logger.error).toHaveBeenCalledWith(
      "[worker] Job failed: Zwift API service unavailable (503): upstream outage",
    );
  });

  it("redrives provider deletion after BullMQ exhausts all attempts", async () => {
    const retry = vi.fn(async () => undefined);

    getProviderDataDeletionRedriveHandler()(
      { attemptsMade: 20, opts: { attempts: 20 }, retry },
      new Error("ClickHouse unavailable"),
    );

    await vi.waitFor(() => {
      expect(retry).toHaveBeenCalledWith("failed", {
        resetAttemptsMade: true,
        resetAttemptsStarted: true,
      });
    });
  });

  it("lets BullMQ handle provider deletion failures before the terminal attempt", () => {
    const retry = vi.fn(async () => undefined);

    getProviderDataDeletionRedriveHandler()(
      { attemptsMade: 19, opts: { attempts: 20 }, retry },
      new Error("ClickHouse unavailable"),
    );

    expect(retry).not.toHaveBeenCalled();
  });

  it("ignores provider deletion failure events without a job", async () => {
    const { markProviderDataDeletionFailed } = await import("../db/provider-data-deletion.ts");
    vi.mocked(markProviderDataDeletionFailed).mockClear();

    expect(
      getProviderDataDeletionRedriveHandler()(undefined, new Error("Missing BullMQ job")),
    ).toBeUndefined();
    expect(markProviderDataDeletionFailed).not.toHaveBeenCalled();
  });

  it("persists unrecoverable provider deletion failures", async () => {
    const { markProviderDataDeletionFailed } = await import("../db/provider-data-deletion.ts");
    const retry = vi.fn(async () => undefined);
    vi.mocked(markProviderDataDeletionFailed).mockClear();

    getProviderDataDeletionRedriveHandler()(
      {
        attemptsMade: 20,
        data: { eventId: "10000000-0000-4000-8000-000000000001" },
        opts: { attempts: 20 },
        retry,
      },
      new hoisted.MockUnrecoverableError("Invalid provider data deletion job payload"),
    );

    expect(retry).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(markProviderDataDeletionFailed).toHaveBeenCalledWith(
        hoisted.mockDatabase,
        "10000000-0000-4000-8000-000000000001",
        "Invalid provider data deletion job payload",
      ),
    );
  });

  it("reports provider deletion failure persistence errors", async () => {
    const Sentry = await import("@sentry/node");
    const { markProviderDataDeletionFailed } = await import("../db/provider-data-deletion.ts");
    const { logger } = await import("../logger.ts");
    const persistenceError = new Error("Postgres unavailable");
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(markProviderDataDeletionFailed).mockRejectedValueOnce(persistenceError);
    vi.mocked(logger.error).mockClear();

    getProviderDataDeletionRedriveHandler()(
      {
        attemptsMade: 20,
        data: { eventId: "10000000-0000-4000-8000-000000000001" },
        opts: { attempts: 20 },
        retry: vi.fn(async () => undefined),
      },
      new hoisted.MockUnrecoverableError("Invalid provider data deletion job payload"),
    );

    await vi.waitFor(() =>
      expect(Sentry.captureException).toHaveBeenCalledWith(persistenceError, {
        tags: { providerDataDeletionStep: "persistFailure" },
        extra: { eventId: "10000000-0000-4000-8000-000000000001" },
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "[provider-data-deletion] Failed to persist terminal failure for 10000000-0000-4000-8000-000000000001: Error: Postgres unavailable",
    );
  });

  it("reports a provider deletion redrive failure with the deletion event context", async () => {
    const Sentry = await import("@sentry/node");
    const { markProviderDataDeletionFailed } = await import("../db/provider-data-deletion.ts");
    const { logger } = await import("../logger.ts");
    const redriveError = new Error("Redis unavailable");
    const retry = vi.fn().mockRejectedValue(redriveError);
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(markProviderDataDeletionFailed).mockClear();
    vi.mocked(logger.error).mockClear();

    getProviderDataDeletionRedriveHandler()(
      {
        attemptsMade: 20,
        data: { eventId: "10000000-0000-4000-8000-000000000001" },
        opts: { attempts: 20 },
        retry,
      },
      new Error("ClickHouse unavailable"),
    );

    await vi.waitFor(() =>
      expect(Sentry.captureException).toHaveBeenCalledWith(redriveError, {
        tags: { providerDataDeletionStep: "redrive" },
        extra: { eventId: "10000000-0000-4000-8000-000000000001" },
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "[provider-data-deletion] Failed to redrive terminal job 10000000-0000-4000-8000-000000000001: Error: Redis unavailable",
    );
    expect(markProviderDataDeletionFailed).toHaveBeenCalledWith(
      hoisted.mockDatabase,
      "10000000-0000-4000-8000-000000000001",
      "ClickHouse unavailable",
    );
  });

  it("suppresses Sentry for FIT batch child failures with UnrecoverableError", async () => {
    const Sentry = await import("@sentry/node");
    const { UnrecoverableError } = await import("bullmq");
    vi.mocked(Sentry.captureException).mockClear();

    const job = {
      attemptsMade: 1,
      opts: {},
      id: "fit-child-1",
      parentKey: "bull:fit-batch:batch-1",
    };
    const error = new UnrecoverableError("invalid FIT file");
    getFitWorkerFailedHandler()(job, error);

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("suppresses Sentry for invalid Apple Health import archives", async () => {
    const Sentry = await import("@sentry/node");
    const { UnrecoverableError } = await import("bullmq");
    vi.mocked(Sentry.captureException).mockClear();

    const error = new UnrecoverableError(
      "Apple Health ZIP must contain export.xml; upload the original Apple Health export archive",
    );
    error.name = APPLE_HEALTH_IMPORT_VALIDATION_ERROR_NAME;
    getWorkerFailedHandler("import-queue")(
      { attemptsMade: 1, opts: {}, id: "apple-health-import-1" },
      error,
    );

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("suppresses Sentry for invalid Strong CSV imports", async () => {
    const Sentry = await import("@sentry/node");
    const { UnrecoverableError } = await import("bullmq");
    vi.mocked(Sentry.captureException).mockClear();

    const error = new UnrecoverableError("Strong CSV must declare one consistent weight unit");
    error.name = STRONG_CSV_IMPORT_VALIDATION_ERROR_NAME;
    getWorkerFailedHandler("import-queue")(
      { attemptsMade: 1, opts: {}, id: "strong-import-1" },
      error,
    );

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("does not suppress Sentry for FIT worker failures without UnrecoverableError", async () => {
    const Sentry = await import("@sentry/node");
    vi.mocked(Sentry.captureException).mockClear();

    const job = {
      attemptsMade: 1,
      opts: {},
      id: "fit-child-2",
      parentKey: "bull:fit-batch:batch-2",
    };
    const error = new Error("transient connection error");
    getFitWorkerFailedHandler()(job, error);

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });

  it("does not suppress Sentry for non-FIT worker UnrecoverableError failures", async () => {
    const Sentry = await import("@sentry/node");
    const { UnrecoverableError } = await import("bullmq");
    vi.mocked(Sentry.captureException).mockClear();

    const job = {
      attemptsMade: 1,
      opts: {},
      id: "sync-child-1",
      parentKey: "bull:sync-batch:batch-1",
    };
    const error = new UnrecoverableError("unrecoverable sync error");
    getWorkerFailedHandler("sync-queue")(job, error);

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });

  it("does not suppress Sentry for FIT worker failures without a parent job", async () => {
    const Sentry = await import("@sentry/node");
    const { UnrecoverableError } = await import("bullmq");
    vi.mocked(Sentry.captureException).mockClear();

    const error = new UnrecoverableError("unrecoverable fit error");
    getFitWorkerFailedHandler()(undefined, error);

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });

  it("error event handler reports to Sentry and logs the error", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();

    const error = new Error("test worker error");
    getWorkerHandler("error")(error);

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
    expect(logger.error).toHaveBeenCalledWith("[worker] Worker error: test worker error");
  });

  it("stalled event handler reports to Sentry and appends the failure to the BullMQ job log", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();
    mockAddJobLog.mockClear();

    getWorkerHandler("stalled")("stalled-job-1", "active");
    await vi.waitFor(() => expect(mockAddJobLog).toHaveBeenCalledOnce());

    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "BullMQ job stalled: queue=sync-strava jobId=stalled-job-1 previousState=active",
      }),
      expect.objectContaining({
        tags: expect.objectContaining({ bullmqEvent: "stalled", queue: "sync-strava" }),
      }),
    );
    expect(mockAddJobLog).toHaveBeenCalledWith(
      expect.objectContaining({ name: "sync-strava" }),
      "stalled-job-1",
      "[error] BullMQ job stalled: queue=sync-strava jobId=stalled-job-1 previousState=active",
      100,
    );
    expect(logger.error).toHaveBeenCalledWith(
      "[worker] BullMQ job stalled: queue=sync-strava jobId=stalled-job-1 previousState=active",
    );
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it("reports a stalled-event job-log write failure", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    const logError = new Error("Redis job log unavailable");
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();
    mockAddJobLog.mockRejectedValueOnce(logError);

    getWorkerHandler("stalled")("stalled-job-1", "active");
    await vi.waitFor(() => expect(Sentry.captureException).toHaveBeenCalledWith(logError));

    expect(logger.error).toHaveBeenCalledWith(
      "[worker] Failed to append stalled job log: Error: Redis job log unavailable",
    );
  });

  it("lockRenewalFailed event handler reports to Sentry and appends the failure to every BullMQ job log", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();
    mockAddJobLog.mockClear();

    getWorkerHandler("lockRenewalFailed")(["locked-job-1", "locked-job-2"]);
    await vi.waitFor(() => expect(mockAddJobLog).toHaveBeenCalledTimes(2));

    const message =
      "BullMQ lock renewal failed: queue=sync-strava jobIds=locked-job-1,locked-job-2";
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message }),
      expect.objectContaining({
        tags: expect.objectContaining({
          bullmqEvent: "lockRenewalFailed",
          queue: "sync-strava",
        }),
        extra: { jobIds: ["locked-job-1", "locked-job-2"] },
      }),
    );
    expect(mockAddJobLog).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: "sync-strava" }),
      "locked-job-1",
      `[error] ${message}`,
      100,
    );
    expect(mockAddJobLog).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: "sync-strava" }),
      "locked-job-2",
      `[error] ${message}`,
      100,
    );
    expect(logger.error).toHaveBeenCalledWith(`[worker] ${message}`);
  });

  it("reports a lock-renewal job-log write failure with queue and job context", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    const logError = new Error("Redis job log unavailable");
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();
    mockAddJobLog.mockRejectedValueOnce(logError);

    getWorkerHandler("lockRenewalFailed")(["locked-job-1"]);
    await vi.waitFor(() =>
      expect(Sentry.captureException).toHaveBeenCalledWith(logError, {
        tags: { bullmqEvent: "lockRenewalFailed", queue: "sync-strava" },
        extra: { jobId: "locked-job-1", operation: "addJobLog" },
      }),
    );

    expect(logger.error).toHaveBeenCalledWith(
      "[worker] Failed to append lock renewal failure job log: queue=sync-strava jobId=locked-job-1: Error: Redis job log unavailable",
    );
  });
});
