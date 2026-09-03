import type { JobsOptions } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import {
  buildSyncRequestJobId,
  registerSyncRequestQueryResolver,
} from "../lib/sync-request-query.ts";
import { resolveWhoopSyncRequestQuery } from "../providers/whoop/sync-request-query.ts";
import type { SyncJobData } from "./queues.ts";
import { enqueueSyncJobWithRequestDedup } from "./sync-request-job.ts";

registerSyncRequestQueryResolver("whoop", resolveWhoopSyncRequestQuery);

describe("resolveWhoopSyncRequestQuery", () => {
  it("maps a fresh sync job to the first bootstrap cycles request", () => {
    expect(
      resolveWhoopSyncRequestQuery({
        userId: "user-1",
        providerId: "whoop",
        sinceDays: 30,
      }),
    ).toEqual({
      path: "core-details-bff/v0/cycles/details",
      filters: expect.objectContaining({
        cursorMs: expect.any(Number),
      }),
    });
  });

  it("maps an API checkpoint to the next step request", () => {
    expect(
      resolveWhoopSyncRequestQuery({
        userId: "user-1",
        providerId: "whoop",
        sinceIso: "2026-05-01T00:00:00.000Z",
        untilIso: "2026-05-03T00:00:00.000Z",
        checkpoint: {
          runId: "run-1",
          recordsSynced: 0,
          phase: "api",
          cycleFetchCursorMs: null,
          cycles: [],
          apiSteps: [
            {
              type: "heart_rate",
              start: "2026-05-01T00:00:00.000Z",
              end: "2026-05-08T00:00:00.000Z",
            },
          ],
          apiStepIndex: 0,
          presentExternalIds: [],
        },
      }),
    ).toEqual({
      path: "metrics-service/v1/metrics",
      filters: {
        name: "heart_rate",
        start: "2026-05-01T00:00:00.000Z",
        end: "2026-05-08T00:00:00.000Z",
        step: 6,
      },
    });
  });

  it("returns bootstrap cycle details query with checkpoint cursor", () => {
    expect(
      resolveWhoopSyncRequestQuery({
        userId: "user-1",
        providerId: "whoop",
        sinceIso: "2026-05-01T00:00:00.000Z",
        untilIso: "2026-05-03T00:00:00.000Z",
        checkpoint: {
          runId: "run-1",
          recordsSynced: 0,
          phase: "bootstrap",
          cycleFetchCursorMs: 1234567890,
          cycles: [],
          apiSteps: [],
          apiStepIndex: 0,
          presentExternalIds: [],
        },
      }),
    ).toEqual({
      path: "core-details-bff/v0/cycles/details",
      filters: {
        start: "2026-05-01T00:00:00.000Z",
        end: "2026-05-03T00:00:00.000Z",
        cursorMs: 1234567890,
      },
    });
  });

  it("returns null for bootstrap checkpoint with null cursor", () => {
    expect(
      resolveWhoopSyncRequestQuery({
        userId: "user-1",
        providerId: "whoop",
        sinceIso: "2026-05-01T00:00:00.000Z",
        untilIso: "2026-05-03T00:00:00.000Z",
        checkpoint: {
          runId: "run-1",
          recordsSynced: 0,
          phase: "bootstrap",
          cycleFetchCursorMs: null,
          cycles: [],
          apiSteps: [],
          apiStepIndex: 0,
          presentExternalIds: [],
        },
      }),
    ).toBeNull();
  });

  it("returns null when API phase step index is out of bounds", () => {
    expect(
      resolveWhoopSyncRequestQuery({
        userId: "user-1",
        providerId: "whoop",
        sinceIso: "2026-05-01T00:00:00.000Z",
        untilIso: "2026-05-03T00:00:00.000Z",
        checkpoint: {
          runId: "run-1",
          recordsSynced: 0,
          phase: "api",
          cycleFetchCursorMs: null,
          cycles: [],
          apiSteps: [],
          apiStepIndex: 0,
          presentExternalIds: [],
        },
      }),
    ).toBeNull();
  });

  it("returns null for a done checkpoint even when api steps exist", () => {
    expect(
      resolveWhoopSyncRequestQuery({
        userId: "user-1",
        providerId: "whoop",
        sinceIso: "2026-05-01T00:00:00.000Z",
        untilIso: "2026-05-03T00:00:00.000Z",
        checkpoint: {
          runId: "run-1",
          recordsSynced: 0,
          phase: "done",
          cycleFetchCursorMs: null,
          cycles: [],
          apiSteps: [
            {
              type: "heart_rate",
              start: "2026-05-01T00:00:00.000Z",
              end: "2026-05-08T00:00:00.000Z",
            },
          ],
          apiStepIndex: 0,
          presentExternalIds: [],
        },
      }),
    ).toBeNull();
  });
});

describe("buildSyncRequestJobId", () => {
  it("is stable for the same provider request", () => {
    const query = {
      path: "metrics-service/v1/metrics",
      filters: {
        name: "heart_rate",
        start: "2026-05-01T00:00:00.000Z",
        end: "2026-05-08T00:00:00.000Z",
        step: 6,
      },
    };
    expect(buildSyncRequestJobId("whoop", "user-1", query)).toBe(
      buildSyncRequestJobId("whoop", "user-1", query),
    );
  });
});

describe("enqueueSyncJobWithRequestDedup", () => {
  const jobData: SyncJobData = {
    userId: "user-1",
    providerId: "whoop",
    sinceDays: 7,
  };
  const jobOptions: JobsOptions = {};

  it("adds a new job when no existing job matches the dedup key", async () => {
    const newJob = {};
    const addJob = vi.fn();
    addJob.mockResolvedValue(newJob);
    const getJob = vi.fn();
    getJob.mockResolvedValue(undefined);

    const result = await enqueueSyncJobWithRequestDedup(
      "whoop",
      jobData,
      jobOptions,
      addJob,
      getJob,
    );

    expect(getJob).toHaveBeenCalledOnce();
    expect(addJob).toHaveBeenCalledOnce();
    expect(addJob).toHaveBeenCalledWith(
      "sync",
      jobData,
      expect.objectContaining({ jobId: expect.any(String) }),
    );
    expect(result).toBe(newJob);
    expect(result?.alreadyQueued).toBe(false);
  });

  it("returns the existing job when it is in a pending state", async () => {
    const remove = vi.fn();
    const existing = { getState: vi.fn(), remove };
    existing.getState.mockResolvedValue("active");
    const addJob = vi.fn();
    const getJob = vi.fn();
    getJob.mockResolvedValue(existing);

    const result = await enqueueSyncJobWithRequestDedup(
      "whoop",
      jobData,
      jobOptions,
      addJob,
      getJob,
    );

    expect(getJob).toHaveBeenCalledOnce();
    expect(addJob).not.toHaveBeenCalled();
    expect(result).toBe(existing);
    expect(result?.alreadyQueued).toBe(true);
  });

  it("removes completed jobs and re-adds with the same jobId", async () => {
    const remove = vi.fn();
    remove.mockResolvedValue(undefined);
    const existing = { getState: vi.fn(), remove };
    existing.getState.mockResolvedValue("completed");
    const replacement = {};
    const addJob = vi.fn();
    addJob.mockResolvedValue(replacement);
    const getJob = vi.fn();
    getJob.mockResolvedValue(existing);

    const result = await enqueueSyncJobWithRequestDedup(
      "whoop",
      jobData,
      jobOptions,
      addJob,
      getJob,
    );

    expect(remove).toHaveBeenCalledOnce();
    expect(addJob).toHaveBeenCalledOnce();
    expect(result).toBe(replacement);
  });

  it("removes failed jobs and re-adds with the same jobId", async () => {
    const remove = vi.fn();
    remove.mockResolvedValue(undefined);
    const existing = { getState: vi.fn(), remove };
    existing.getState.mockResolvedValue("failed");
    const replacement = {};
    const addJob = vi.fn();
    addJob.mockResolvedValue(replacement);
    const getJob = vi.fn();
    getJob.mockResolvedValue(existing);

    const result = await enqueueSyncJobWithRequestDedup(
      "whoop",
      jobData,
      jobOptions,
      addJob,
      getJob,
    );

    expect(remove).toHaveBeenCalledOnce();
    expect(addJob).toHaveBeenCalledOnce();
    expect(result).toBe(replacement);
  });

  it("still sets a jobId for providers without a custom resolver (uses default)", async () => {
    const newJob = {};
    const addJob = vi.fn();
    addJob.mockResolvedValue(newJob);
    const getJob = vi.fn();
    getJob.mockResolvedValue(undefined);

    const result = await enqueueSyncJobWithRequestDedup(
      "strava",
      jobData,
      jobOptions,
      addJob,
      getJob,
    );

    expect(getJob).toHaveBeenCalledOnce();
    expect(addJob).toHaveBeenCalledWith(
      "sync",
      jobData,
      expect.objectContaining({ jobId: expect.any(String) }),
    );
    expect(result).toBe(newJob);
  });

  it("reports a BullMQ lifecycle-deduplicated job as already queued", async () => {
    const existingJob = { id: "first-full-job" };
    const addJob = vi.fn().mockResolvedValue(existingJob);
    const getJob = vi.fn().mockResolvedValue(undefined);

    const result = await enqueueSyncJobWithRequestDedup(
      "strava",
      {
        userId: "user-1",
        providerId: "strava",
        sinceIso: "1970-01-01T00:00:00.000Z",
        untilIso: "2026-07-29T17:00:01.000Z",
        targetRefreshWindow: { type: "full" },
      },
      { deduplication: { id: "sync:full:strava:user-1" } },
      addJob,
      getJob,
    );

    expect(addJob).toHaveBeenCalledWith(
      "sync",
      expect.anything(),
      expect.objectContaining({
        jobId: expect.stringMatching(/^sync-req-strava-user-1-/),
        deduplication: { id: "sync:full:strava:user-1" },
      }),
    );
    expect(result).toBe(existingJob);
    expect(result?.alreadyQueued).toBe(true);
  });

  it.each([
    {
      name: "lifecycle deduplication is absent",
      jobOptions: {},
      returnedJobId: "different-job-id",
      jobData,
    },
    {
      name: "request job ID is absent",
      jobOptions: { deduplication: { id: "sync:full:whoop:user-1" } },
      returnedJobId: "different-job-id",
      jobData: {
        userId: "user-1",
        providerId: "whoop",
        checkpoint: {
          runId: "run-1",
          recordsSynced: 0,
          phase: "done" as const,
          cycleFetchCursorMs: null,
          cycles: [],
          apiSteps: [],
          apiStepIndex: 0,
          presentExternalIds: [],
        },
      },
    },
    {
      name: "BullMQ returns no job ID",
      jobOptions: { deduplication: { id: "sync:full:whoop:user-1" } },
      returnedJobId: undefined,
      jobData,
    },
    {
      name: "BullMQ returns the requested job ID",
      jobOptions: { deduplication: { id: "sync:full:whoop:user-1" } },
      returnedJobId: "requested-job-id",
      jobData,
    },
  ])(
    "does not report already queued when $name",
    async ({ jobOptions, returnedJobId, jobData }) => {
      const returnedJob = { id: returnedJobId };
      const addJob = vi.fn().mockImplementation(async (_name, _data, options: JobsOptions) => {
        if (returnedJobId === "requested-job-id") {
          returnedJob.id = options.jobId;
        }
        return returnedJob;
      });
      const getJob = vi.fn().mockResolvedValue(undefined);

      const result = await enqueueSyncJobWithRequestDedup(
        "whoop",
        jobData,
        jobOptions,
        addJob,
        getJob,
      );

      expect(result?.alreadyQueued).toBe(false);
    },
  );

  it("returns an existing cooldown-delayed job without enqueueing a duplicate", async () => {
    const existing = { getState: vi.fn(), remove: vi.fn() };
    existing.getState.mockResolvedValue("delayed");
    const addJob = vi.fn();
    const getJob = vi.fn();
    getJob.mockResolvedValue(existing);

    const result = await enqueueSyncJobWithRequestDedup(
      "garmin",
      jobData,
      { jobId: "rate-limit-delayed-job", delay: 600_000 },
      addJob,
      getJob,
    );

    expect(getJob).toHaveBeenCalledWith("rate-limit-delayed-job");
    expect(addJob).not.toHaveBeenCalled();
    expect(result).toBe(existing);
  });
});
