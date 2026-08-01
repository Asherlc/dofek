import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_ERASURE_ACTIVE_PHASES,
  type AccountErasureJobDependencies,
  type AccountErasurePhase,
  type AccountErasureRequest,
  processAccountErasureJob,
} from "./process-account-erasure-job.ts";

const request: AccountErasureRequest = {
  id: "10000000-0000-4000-8000-000000000001",
  requestedAt: new Date("2026-07-26T12:00:00.000Z"),
  replayRetainedUntil: new Date("2026-08-02T12:00:00.000Z"),
  retentionVerificationAt: new Date("2026-08-24T12:00:00.000Z"),
  userId: "20000000-0000-4000-8000-000000000001",
};

function dependencies(completedPhases: readonly string[] = []) {
  const runPhase = vi.fn<
    (
      phase: AccountErasurePhase,
      request: AccountErasureRequest,
    ) => Promise<Record<string, unknown> | null>
  >(async () => null);
  const markCompleted = vi.fn<AccountErasureJobDependencies["markCompleted"]>(
    async () => undefined,
  );
  const markWaiting = vi.fn<AccountErasureJobDependencies["markWaiting"]>(async () => undefined);
  const loadCompletedPhases = vi.fn<AccountErasureJobDependencies["loadCompletedPhases"]>(
    async () => new Set(completedPhases),
  );
  const finalize = vi.fn<AccountErasureJobDependencies["finalize"]>(async () => undefined);
  return {
    finalize,
    loadCompletedPhases,
    markCompleted,
    markWaiting,
    runPhase,
  };
}

describe("processAccountErasureJob", () => {
  it("runs every destructive phase in order and finalizes after the retention boundary", async () => {
    const deps = dependencies();

    await expect(
      processAccountErasureJob(request, deps, new Date("2026-08-25T12:00:00.001Z")),
    ).resolves.toEqual({ status: "completed" });

    expect(deps.runPhase.mock.calls.map(([phase]) => phase)).toEqual(ACCOUNT_ERASURE_ACTIVE_PHASES);
    expect(deps.markCompleted.mock.calls.map(([, phase]) => phase)).toEqual(
      ACCOUNT_ERASURE_ACTIVE_PHASES,
    );
    expect(deps.markWaiting).not.toHaveBeenCalled();
    expect(deps.finalize).toHaveBeenCalledWith(request, new Date("2026-08-25T12:00:00.001Z"));
  });

  it("persists the replay wait after initial erasure and does not claim completion", async () => {
    const deps = dependencies();

    await expect(
      processAccountErasureJob(request, deps, new Date("2026-07-26T12:00:00.000Z")),
    ).resolves.toEqual({
      retryAt: request.replayRetainedUntil,
      status: "waiting",
      waitReason: "replay",
    });

    expect(deps.runPhase.mock.calls.map(([phase]) => phase)).toEqual([
      "ingest_fence",
      "stripe_erasure",
      "work_purge",
      "consumer_drain",
      "remote_revocation",
      "processor_erasure",
      "postgres_erasure",
      "clickhouse_initial",
      "archive_initial",
    ]);
    expect(deps.markWaiting).toHaveBeenCalledWith(
      request.id,
      request.replayRetainedUntil,
      "replay",
    );
  });

  it("persists a distinct retention wait after active-store verification", async () => {
    const deps = dependencies([
      "ingest_fence",
      "stripe_erasure",
      "remote_revocation",
      "processor_erasure",
      "work_purge",
      "consumer_drain",
      "postgres_erasure",
      "clickhouse_initial",
      "archive_initial",
    ]);

    await expect(
      processAccountErasureJob(request, deps, new Date("2026-08-03T00:00:00.000Z")),
    ).resolves.toEqual({
      retryAt: request.retentionVerificationAt,
      status: "waiting",
      waitReason: "retention",
    });

    expect(deps.runPhase.mock.calls.map(([phase]) => phase)).toEqual([
      "work_verification",
      "consumer_drain_verification",
      "stripe_erasure_verification",
      "remote_revocation_verification",
      "processor_erasure_verification",
      "postgres_profile_delete",
      "peerdb_drain_verification",
      "clickhouse_verification",
      "archive_verification",
      "request_pii_scrub",
    ]);
    expect(deps.markWaiting).toHaveBeenCalledWith(
      request.id,
      request.retentionVerificationAt,
      "retention",
    );
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it("resumes from durable checkpoints without repeating completed external effects", async () => {
    const deps = dependencies([
      "ingest_fence",
      "stripe_erasure",
      "remote_revocation",
      "processor_erasure",
      "work_purge",
      "consumer_drain",
      "postgres_erasure",
      "clickhouse_initial",
      "archive_initial",
      "work_verification",
      "consumer_drain_verification",
      "stripe_erasure_verification",
      "remote_revocation_verification",
      "processor_erasure_verification",
      "postgres_profile_delete",
      "peerdb_drain_verification",
      "clickhouse_verification",
      "archive_verification",
      "request_pii_scrub",
    ]);

    await processAccountErasureJob(request, deps, new Date("2026-08-25T12:00:00.001Z"));

    expect(deps.runPhase.mock.calls.map(([phase]) => phase)).toEqual(["retention_verification"]);
    expect(deps.finalize).toHaveBeenCalledWith(request, new Date("2026-08-25T12:00:00.001Z"));
  });

  it("does not checkpoint failed phases and still attempts every independent effect", async () => {
    const deps = dependencies();
    const failure = new Error("Apple revocation failed");
    deps.runPhase.mockImplementation(async (phase) => {
      if (phase === "remote_revocation") throw failure;
      return null;
    });

    await expect(
      processAccountErasureJob(request, deps, new Date("2026-08-25T12:00:00.001Z")),
    ).rejects.toThrow("initial account erasure");

    expect(deps.markCompleted).not.toHaveBeenCalledWith(
      request.id,
      "remote_revocation",
      expect.anything(),
    );
    expect(deps.markCompleted).toHaveBeenCalledWith(request.id, "work_purge", null);
    expect(deps.runPhase).toHaveBeenCalledWith("processor_erasure", request);
    expect(deps.runPhase).toHaveBeenCalledWith("postgres_erasure", request);
  });

  it("attempts every immediate safety effect when the permanent ingest fence fails", async () => {
    const deps = dependencies();
    deps.runPhase.mockImplementation(async (phase) => {
      if (phase === "ingest_fence") throw new Error("ClickHouse unavailable");
      return null;
    });

    await expect(
      processAccountErasureJob(request, deps, new Date("2026-08-25T12:00:00.001Z")),
    ).rejects.toThrow("initial account erasure");

    expect(deps.runPhase.mock.calls.map(([phase]) => phase)).toEqual([
      "ingest_fence",
      "stripe_erasure",
      "work_purge",
      "consumer_drain",
    ]);
    expect(deps.markCompleted).not.toHaveBeenCalledWith(request.id, "ingest_fence", null);
    expect(deps.markCompleted).toHaveBeenCalledWith(request.id, "stripe_erasure", null);
    expect(deps.markCompleted).not.toHaveBeenCalledWith(request.id, "work_purge", null);
    expect(deps.markCompleted).not.toHaveBeenCalledWith(request.id, "consumer_drain", null);
    expect(deps.runPhase).not.toHaveBeenCalledWith("postgres_erasure", request);
  });

  it("reruns quiescence phases after the ingest fence succeeds on retry", async () => {
    const durableCompleted = new Set<string>();
    const deps = dependencies();
    deps.loadCompletedPhases.mockImplementation(async () => new Set(durableCompleted));
    deps.markCompleted.mockImplementation(async (_requestId, phase) => {
      durableCompleted.add(phase);
    });
    let ingestFenceUnavailable = true;
    deps.runPhase.mockImplementation(async (phase) => {
      if (phase === "ingest_fence" && ingestFenceUnavailable) {
        throw new Error("ClickHouse unavailable");
      }
      return null;
    });

    await expect(
      processAccountErasureJob(request, deps, new Date("2026-07-26T12:00:00.000Z")),
    ).rejects.toThrow("initial account erasure");

    expect([...durableCompleted]).toEqual(["stripe_erasure"]);

    ingestFenceUnavailable = false;
    deps.runPhase.mockClear();

    await expect(
      processAccountErasureJob(request, deps, new Date("2026-07-26T12:00:00.000Z")),
    ).resolves.toEqual({
      retryAt: request.replayRetainedUntil,
      status: "waiting",
      waitReason: "replay",
    });
    expect(deps.runPhase.mock.calls.map(([phase]) => phase)).toEqual([
      "ingest_fence",
      "work_purge",
      "consumer_drain",
      "remote_revocation",
      "processor_erasure",
      "postgres_erasure",
      "clickhouse_initial",
      "archive_initial",
    ]);
  });

  it("establishes the permanent ingest fence even when Stripe fails", async () => {
    const deps = dependencies();
    deps.runPhase.mockImplementation(async (phase) => {
      if (phase === "stripe_erasure") throw new Error("Stripe unavailable");
      return null;
    });

    await expect(
      processAccountErasureJob(request, deps, new Date("2026-08-03T00:00:00.000Z")),
    ).rejects.toThrow("initial account erasure");

    expect(deps.runPhase).toHaveBeenNthCalledWith(1, "ingest_fence", request);
    expect(deps.markCompleted).toHaveBeenCalledWith(request.id, "ingest_fence", null);
    expect(deps.runPhase).toHaveBeenNthCalledWith(2, "stripe_erasure", request);
    expect(deps.runPhase).toHaveBeenCalledWith("work_purge", request);
    expect(deps.runPhase).toHaveBeenCalledWith("postgres_erasure", request);
  });

  it("runs local erasure when remote and processor deletion fail", async () => {
    const deps = dependencies();
    deps.runPhase.mockImplementation(async (phase) => {
      if (phase === "remote_revocation" || phase === "processor_erasure") {
        throw new Error(`${phase} unavailable`);
      }
      return null;
    });

    await expect(
      processAccountErasureJob(request, deps, new Date("2026-07-26T12:00:00.000Z")),
    ).rejects.toThrow("initial account erasure");

    expect(deps.markCompleted.mock.calls.map(([, phase]) => phase)).toEqual([
      "ingest_fence",
      "stripe_erasure",
      "work_purge",
      "consumer_drain",
      "postgres_erasure",
      "clickhouse_initial",
      "archive_initial",
    ]);
  });

  it("blocks remote and local erasure until active account work is quiescent", async () => {
    const deps = dependencies();
    deps.runPhase.mockImplementation(async (phase) => {
      if (phase === "work_purge") {
        throw new Error("active export is still running");
      }
      return null;
    });

    await expect(
      processAccountErasureJob(request, deps, new Date("2026-07-26T12:00:00.000Z")),
    ).rejects.toThrow("initial account erasure");

    expect(deps.runPhase).toHaveBeenCalledWith("stripe_erasure", request);
    expect(deps.runPhase).not.toHaveBeenCalledWith("remote_revocation", request);
    expect(deps.runPhase).not.toHaveBeenCalledWith("postgres_erasure", request);
  });

  it("never finalizes after any verification failure", async () => {
    const deps = dependencies([
      "ingest_fence",
      "stripe_erasure",
      "work_purge",
      "consumer_drain",
      "remote_revocation",
      "processor_erasure",
      "postgres_erasure",
      "clickhouse_initial",
      "archive_initial",
    ]);
    deps.runPhase.mockImplementation(async (phase) => {
      if (phase === "processor_erasure_verification") {
        throw new Error("processor deletion is still pending");
      }
      return null;
    });

    await expect(
      processAccountErasureJob(request, deps, new Date("2026-08-25T12:00:00.001Z")),
    ).rejects.toThrow("account erasure effects failed");

    expect(deps.runPhase).not.toHaveBeenCalledWith("postgres_profile_delete", request);
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it("does not drain PeerDB or sweep ClickHouse before the profile WAL checkpoint persists", async () => {
    const deps = dependencies([
      "ingest_fence",
      "stripe_erasure",
      "work_purge",
      "consumer_drain",
      "remote_revocation",
      "processor_erasure",
      "postgres_erasure",
      "clickhouse_initial",
      "archive_initial",
      "work_verification",
      "consumer_drain_verification",
      "stripe_erasure_verification",
      "remote_revocation_verification",
      "processor_erasure_verification",
    ]);
    deps.runPhase.mockImplementation(async (phase) =>
      phase === "postgres_profile_delete" ? { walLsn: "0/1A2B" } : null,
    );
    deps.markCompleted.mockImplementation(async (_requestId, phase) => {
      if (phase === "postgres_profile_delete") {
        throw new Error("profile WAL checkpoint unavailable");
      }
    });

    await expect(
      processAccountErasureJob(request, deps, new Date("2026-08-03T00:00:00.000Z")),
    ).rejects.toThrow("profile WAL checkpoint unavailable");

    expect(deps.runPhase).toHaveBeenCalledWith("postgres_profile_delete", request);
    expect(deps.runPhase).not.toHaveBeenCalledWith("peerdb_drain_verification", request);
    expect(deps.runPhase).not.toHaveBeenCalledWith("clickhouse_verification", request);
  });
});
