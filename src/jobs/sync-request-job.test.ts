import type { JobsOptions } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { registerSyncRequestQueryResolver } from "../lib/sync-request-query.ts";
import { resolveWhoopSyncRequestQuery } from "../providers/whoop/sync-request-query.ts";
import type { SyncJobData } from "./queues.ts";
import { enqueueSyncJobWithRequestDedup } from "./sync-request-job.ts";

registerSyncRequestQueryResolver("whoop", resolveWhoopSyncRequestQuery);

describe("enqueueSyncJobWithRequestDedup", () => {
  const jobData: SyncJobData = {
    userId: "user-1",
    providerId: "whoop",
    sinceDays: 7,
  };
  const jobOptions: JobsOptions = {};

  it.each(["completed", "failed"])("reuses a %s child for the same coordinator", async (state) => {
    const existing = { getState: vi.fn().mockResolvedValue(state), remove: vi.fn() };
    const addJob = vi.fn();
    const getJob = vi.fn().mockResolvedValue(existing);
    const result = await enqueueSyncJobWithRequestDedup(
      "whoop",
      jobData,
      jobOptions,
      addJob,
      getJob,
      { id: "coordinator-1", queueQualifiedName: "bull:sync" },
    );
    expect(result).toBe(existing);
    expect(result?.alreadyQueued).toBe(true);
    expect(existing.remove).not.toHaveBeenCalled();
    expect(addJob).not.toHaveBeenCalled();
  });
  it("atomically registers a coordinator parent with independent terminal failures", async () => {
    const addJob = vi.fn().mockResolvedValue({ id: "child" });
    await enqueueSyncJobWithRequestDedup(
      "whoop",
      jobData,
      jobOptions,
      addJob,
      vi.fn().mockResolvedValue(undefined),
      {
        id: "coordinator-1",
        queueQualifiedName: "bull:sync",
      },
    );
    expect(addJob).toHaveBeenCalledWith(
      "sync",
      jobData,
      expect.objectContaining({
        parent: { id: "coordinator-1", queue: "bull:sync" },
        ignoreDependencyOnFailure: true,
      }),
    );
  });

  it("replaces a coordinator child that is neither pending nor terminal", async () => {
    const existing = {
      getState: vi.fn().mockResolvedValue("unknown"),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const addJob = vi.fn().mockResolvedValue({ id: "replacement" });
    const result = await enqueueSyncJobWithRequestDedup(
      "whoop",
      jobData,
      jobOptions,
      addJob,
      vi.fn().mockResolvedValue(existing),
      {
        id: "coordinator-1",
        queueQualifiedName: "bull:sync",
      },
    );
    expect(existing.remove).toHaveBeenCalledOnce();
    expect(addJob).toHaveBeenCalledOnce();
    expect(result?.id).toBe("replacement");
    expect(result?.alreadyQueued).toBe(false);
  });

  it("scopes coordinator child identity by parent and provider", async () => {
    const addJob = vi.fn().mockResolvedValue({ id: "child" });
    const getJob = vi.fn().mockResolvedValue(undefined);
    await enqueueSyncJobWithRequestDedup("whoop", jobData, jobOptions, addJob, getJob, {
      id: "coordinator-1",
      queueQualifiedName: "bull:sync",
    });
    const firstId = getJob.mock.calls[0]?.[0];
    await enqueueSyncJobWithRequestDedup("whoop", jobData, jobOptions, addJob, getJob, {
      id: "coordinator-2",
      queueQualifiedName: "bull:sync",
    });
    expect(getJob.mock.calls[1]?.[0]).not.toBe(firstId);
    await enqueueSyncJobWithRequestDedup("garmin", jobData, jobOptions, addJob, getJob, {
      id: "coordinator-1",
      queueQualifiedName: "bull:sync",
    });
    expect(getJob.mock.calls[2]?.[0]).not.toBe(firstId);
    await enqueueSyncJobWithRequestDedup("whoop", jobData, jobOptions, addJob, getJob, {
      id: "coordinator-1",
      queueQualifiedName: "bull:sync",
    });
    expect(getJob.mock.calls[3]?.[0]).toBe(firstId);
  });

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
      if (jobData.checkpoint !== undefined) expect(getJob).not.toHaveBeenCalled();
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
