import { describe, expect, it } from "vitest";
import { deriveProcessingState, type ProcessingStageEvent } from "./processing-state.ts";

const now = new Date("2026-07-22T12:00:00.000Z");

function event(
  sequence: number,
  stage: ProcessingStageEvent["stage"],
  status: ProcessingStageEvent["status"],
  datasetKey: string | null,
  occurredAt = new Date(now.getTime() - 1_000),
  outputPath: ProcessingStageEvent["outputPath"] = null,
  progressPercentage: number | null = null,
): ProcessingStageEvent {
  return {
    sequence,
    stage,
    status,
    datasetKey,
    outputPath,
    occurredAt,
    progressPercentage,
  };
}

describe("deriveProcessingState", () => {
  it("uses monotonic sequence rather than timestamps to select the latest fact", () => {
    const state = deriveProcessingState({
      datasetKeys: ["activity"],
      outputManifest: { activity: ["relational"] },
      events: [
        event(1, "ingest", "failed", "activity", now),
        event(2, "ingest", "succeeded", "activity", new Date(now.getTime() - 60_000)),
      ],
      now,
      delayedAfterMs: 300_000,
    });

    expect(state.datasets[0]).toMatchObject({
      currentStage: "canonical_commit",
      status: "waiting",
    });
  });

  it("applies operation-wide events to each dataset", () => {
    const state = deriveProcessingState({
      datasetKeys: ["activity"],
      outputManifest: { activity: ["relational"] },
      events: [event(1, "ingest", "succeeded", null)],
      now,
      delayedAfterMs: 300_000,
    });

    expect(state.datasets[0]).toMatchObject({
      currentStage: "canonical_commit",
      status: "waiting",
    });
  });

  it("uses the latest output-path fact when a stage has multiple active facts", () => {
    const state = deriveProcessingState({
      datasetKeys: ["activity"],
      outputManifest: { activity: ["relational", "metric_stream"] },
      events: [
        event(1, "ingest", "succeeded", "activity"),
        event(2, "canonical_commit", "queued", "activity", undefined, "relational", 10),
        event(3, "canonical_commit", "running", "activity", undefined, "metric_stream", 40),
      ],
      now,
      delayedAfterMs: 300_000,
    });

    expect(state.datasets[0]).toMatchObject({
      currentStage: "canonical_commit",
      status: "active",
      progressPercentage: 40,
    });
  });

  it("gives failures precedence over unrelated active work", () => {
    const state = deriveProcessingState({
      datasetKeys: ["activity", "sleep"],
      outputManifest: { activity: ["relational"], sleep: ["relational"] },
      events: [event(1, "ingest", "running", "activity"), event(2, "analytics", "failed", "sleep")],
      now,
      delayedAfterMs: 300_000,
    });

    expect(state.overallStatus).toBe("failed");
  });

  it("reports the most recent failure fact", () => {
    const latestFailureTime = new Date(now.getTime() - 2_000);
    const state = deriveProcessingState({
      datasetKeys: ["activity"],
      outputManifest: { activity: ["relational"] },
      events: [
        event(1, "ingest", "failed", "activity", new Date(now.getTime() - 3_000), null, 10),
        event(2, "analytics", "failed", "activity", latestFailureTime, null, 70),
      ],
      now,
      delayedAfterMs: 300_000,
    });

    expect(state.datasets[0]).toEqual({
      datasetKey: "activity",
      currentStage: "analytics",
      status: "failed",
      progressPercentage: 70,
      lastAdvancedAt: latestFailureTime,
    });
  });

  it("reports the most recent cancellation fact", () => {
    const latestCancellationTime = new Date(now.getTime() - 2_000);
    const state = deriveProcessingState({
      datasetKeys: ["activity"],
      outputManifest: { activity: ["relational"] },
      events: [
        event(1, "ingest", "cancelled", "activity", new Date(now.getTime() - 3_000), null, 10),
        event(2, "cdc", "cancelled", "activity", latestCancellationTime, "relational", 60),
      ],
      now,
      delayedAfterMs: 300_000,
    });

    expect(state).toEqual({
      overallStatus: "cancelled",
      datasets: [
        {
          datasetKey: "activity",
          currentStage: "cdc",
          status: "cancelled",
          progressPercentage: 60,
          lastAdvancedAt: latestCancellationTime,
        },
      ],
    });
  });

  it("reports operation cancellation before any dataset event", () => {
    const state = deriveProcessingState({
      datasetKeys: ["activity"],
      outputManifest: { activity: ["relational"] },
      events: [],
      operationStatus: "cancelled",
      now,
      delayedAfterMs: 300_000,
    });

    expect(state).toEqual({
      overallStatus: "cancelled",
      datasets: [
        {
          datasetKey: "activity",
          currentStage: "ingest",
          status: "cancelled",
          progressPercentage: null,
          lastAdvancedAt: null,
        },
      ],
    });
  });

  it("surfaces a cancelled dataset while a sibling dataset is active", () => {
    const state = deriveProcessingState({
      datasetKeys: ["activity", "sleep"],
      outputManifest: {},
      events: [event(1, "ingest", "cancelled", "activity"), event(2, "ingest", "running", "sleep")],
      now,
      delayedAfterMs: 300_000,
    });

    expect(state.overallStatus).toBe("cancelled");
    expect(state.datasets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ datasetKey: "activity", status: "cancelled" }),
        expect.objectContaining({ datasetKey: "sleep", status: "active" }),
      ]),
    );
  });

  it("reports partial readiness while one dataset remains active", () => {
    const completedActivity = [
      event(1, "ingest", "succeeded", "activity"),
      event(2, "canonical_commit", "succeeded", "activity", undefined, "relational"),
      event(3, "cdc", "succeeded", "activity", undefined, "relational"),
      event(4, "analytics", "succeeded", "activity"),
      event(5, "cache_refresh", "succeeded", "activity"),
    ];
    const state = deriveProcessingState({
      datasetKeys: ["activity", "sleep"],
      outputManifest: { activity: ["relational"], sleep: ["relational"] },
      events: [
        ...completedActivity,
        event(6, "ingest", "succeeded", "sleep"),
        event(7, "canonical_commit", "succeeded", "sleep", undefined, "relational"),
        event(8, "cdc", "succeeded", "sleep", undefined, "relational"),
        event(9, "analytics", "running", "sleep"),
      ],
      now,
      delayedAfterMs: 300_000,
    });

    expect(state.overallStatus).toBe("partial");
    expect(state.datasets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ datasetKey: "activity", status: "ready" }),
        expect.objectContaining({ datasetKey: "sleep", status: "active" }),
      ]),
    );
  });

  it("derives delayed state without persisting a delayed event", () => {
    const state = deriveProcessingState({
      datasetKeys: ["activity"],
      outputManifest: { activity: ["relational"] },
      events: [
        event(1, "ingest", "succeeded", "activity"),
        event(2, "canonical_commit", "succeeded", "activity", undefined, "relational"),
        event(3, "cdc", "running", "activity", new Date(now.getTime() - 301_000), "relational"),
      ],
      now,
      delayedAfterMs: 300_000,
    });

    expect(state.datasets[0]).toMatchObject({ currentStage: "cdc", status: "delayed" });
    expect(state.overallStatus).toBe("delayed");
  });

  it("keeps a recent terminal operation waiting for its required downstream stage", () => {
    const state = deriveProcessingState({
      datasetKeys: ["activity"],
      outputManifest: { activity: ["relational"] },
      events: [event(1, "ingest", "succeeded", "activity")],
      operationStatus: "succeeded",
      now,
      delayedAfterMs: 300_000,
    });

    expect(state.datasets[0]).toMatchObject({
      currentStage: "canonical_commit",
      status: "waiting",
    });
    expect(state.overallStatus).toBe("waiting");
  });

  it("keeps a terminal operation without processing facts waiting", () => {
    const state = deriveProcessingState({
      datasetKeys: ["activity"],
      outputManifest: { activity: ["relational"] },
      events: [],
      operationStatus: "succeeded",
      now,
      delayedAfterMs: 300_000,
    });

    expect(state.datasets[0]).toMatchObject({
      currentStage: "ingest",
      status: "waiting",
      lastAdvancedAt: null,
    });
  });

  it("keeps a terminal operation waiting at the exact delay boundary", () => {
    const state = deriveProcessingState({
      datasetKeys: ["activity"],
      outputManifest: { activity: ["relational"] },
      events: [event(1, "ingest", "succeeded", "activity", new Date(now.getTime() - 300_000))],
      operationStatus: "succeeded",
      now,
      delayedAfterMs: 300_000,
    });

    expect(state.datasets[0]).toMatchObject({
      currentStage: "canonical_commit",
      status: "waiting",
    });
  });

  it("keeps stale non-terminal operations waiting for downstream work", () => {
    const state = deriveProcessingState({
      datasetKeys: ["activity"],
      outputManifest: { activity: ["relational"] },
      events: [event(1, "ingest", "succeeded", "activity", new Date(now.getTime() - 300_001))],
      operationStatus: "running",
      now,
      delayedAfterMs: 300_000,
    });

    expect(state.datasets[0]).toMatchObject({
      currentStage: "canonical_commit",
      status: "waiting",
    });
  });

  it("blocks stale failed operations that omit downstream work", () => {
    const state = deriveProcessingState({
      datasetKeys: ["activity"],
      outputManifest: { activity: ["relational"] },
      events: [event(1, "ingest", "succeeded", "activity", new Date(now.getTime() - 300_001))],
      operationStatus: "failed",
      now,
      delayedAfterMs: 300_000,
    });

    expect(state.datasets[0]).toMatchObject({
      currentStage: "canonical_commit",
      status: "blocked",
    });
  });

  it("derives blocked when a terminal operation omits a required stage past the delay budget", () => {
    const state = deriveProcessingState({
      datasetKeys: ["activity"],
      outputManifest: { activity: ["relational"] },
      events: [event(1, "ingest", "succeeded", "activity", new Date(now.getTime() - 300_001))],
      operationStatus: "succeeded",
      now,
      delayedAfterMs: 300_000,
    });

    expect(state.datasets[0]).toMatchObject({
      currentStage: "canonical_commit",
      status: "blocked",
    });
    expect(state.overallStatus).toBe("blocked");
  });

  it("completes relational-only output without requiring metric-stream evidence", () => {
    const state = deriveProcessingState({
      datasetKeys: ["activity"],
      outputManifest: { activity: ["relational"] },
      events: [
        event(1, "ingest", "succeeded", "activity"),
        event(2, "canonical_commit", "succeeded", "activity", undefined, "relational"),
        event(3, "cdc", "succeeded", "activity", undefined, "relational"),
        event(4, "analytics", "succeeded", "activity"),
        event(5, "cache_refresh", "succeeded", "activity"),
      ],
      now,
      delayedAfterMs: 300_000,
    });

    expect(state.overallStatus).toBe("ready");
  });

  it("completes metric-only output without requiring relational evidence", () => {
    const state = deriveProcessingState({
      datasetKeys: ["activity"],
      outputManifest: { activity: ["metric_stream"] },
      events: [
        event(1, "ingest", "succeeded", "activity"),
        event(2, "canonical_commit", "succeeded", "activity", undefined, "metric_stream"),
        event(3, "cdc", "succeeded", "activity", undefined, "metric_stream"),
        event(4, "analytics", "succeeded", "activity"),
        event(5, "cache_refresh", "succeeded", "activity"),
      ],
      now,
      delayedAfterMs: 300_000,
    });

    expect(state.overallStatus).toBe("ready");
  });

  it("waits for both independently emitted output paths", () => {
    const state = deriveProcessingState({
      datasetKeys: ["activity"],
      outputManifest: { activity: ["relational", "metric_stream"] },
      events: [
        event(1, "ingest", "succeeded", "activity"),
        event(2, "canonical_commit", "succeeded", "activity", undefined, "relational"),
        event(3, "canonical_commit", "succeeded", "activity", undefined, "metric_stream"),
        event(4, "cdc", "succeeded", "activity", undefined, "relational"),
      ],
      now,
      delayedAfterMs: 300_000,
    });

    expect(state.datasets[0]).toMatchObject({ currentStage: "cdc", status: "waiting" });
  });

  it("allows a legitimate no-output operation to skip downstream work", () => {
    const state = deriveProcessingState({
      datasetKeys: ["activity"],
      outputManifest: { activity: [] },
      events: [
        event(1, "ingest", "succeeded", "activity"),
        event(2, "analytics", "skipped", "activity"),
        event(3, "cache_refresh", "skipped", "activity"),
      ],
      now,
      delayedAfterMs: 300_000,
    });

    expect(state.overallStatus).toBe("ready");
  });

  it("treats a dataset omitted from the manifest as having no output", () => {
    const lastEventTime = new Date(now.getTime() - 500);
    const state = deriveProcessingState({
      datasetKeys: ["activity"],
      outputManifest: {},
      events: [
        event(1, "ingest", "succeeded", "activity"),
        event(2, "analytics", "skipped", "activity"),
        event(3, "cache_refresh", "skipped", "activity", lastEventTime),
      ],
      now,
      delayedAfterMs: 300_000,
    });

    expect(state.datasets[0]).toEqual({
      datasetKey: "activity",
      currentStage: "cache_refresh",
      status: "ready",
      progressPercentage: 100,
      lastAdvancedAt: lastEventTime,
    });
  });
});
