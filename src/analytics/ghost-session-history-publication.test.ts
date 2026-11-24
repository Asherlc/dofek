import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withAccountErasureUserWriteFence } from "../db/account-erasure.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { createDatabase } from "../db/index.ts";
import { readGhostRouteLabelsInput } from "../jobs/process-ghost-route-labels-job.ts";
import { enqueueGhostRouteLabels } from "../jobs/queues.ts";
import { queryCache } from "../lib/cache.ts";
import { captureException } from "../lib/error-reporting.ts";
import { readGhostRouteLabelsCache } from "../lib/ghost-route-labels-cache.ts";
import {
  ANALYTICS_PUBLICATION_RESOURCE,
  type AnalyticsQueryOwner,
  withAnalyticsQueryOwner,
} from "./analytics-query-owner.ts";
import { runAnalyticsWithGhostHistory } from "./ghost-session-history-publication.ts";
import {
  getGhostSessionHistoryProgress,
  runGhostSessionHistory,
} from "./ghost-session-history-runner.ts";

vi.mock("../db/account-erasure.ts", () => ({ withAccountErasureUserWriteFence: vi.fn() }));
vi.mock("../jobs/process-ghost-route-labels-job.ts", () => ({
  readGhostRouteLabelsInput: vi.fn(),
}));
vi.mock("../jobs/queues.ts", () => ({ enqueueGhostRouteLabels: vi.fn() }));
vi.mock("../lib/cache.ts", () => ({ queryCache: { get: vi.fn() } }));
vi.mock("../lib/error-reporting.ts", () => ({ captureException: vi.fn() }));
vi.mock("../lib/ghost-route-labels-cache.ts", () => ({ readGhostRouteLabelsCache: vi.fn() }));
vi.mock("./analytics-query-owner.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./analytics-query-owner.ts")>()),
  withAnalyticsQueryOwner: vi.fn(),
}));
vi.mock("./ghost-session-history-runner.ts", () => ({
  getGhostSessionHistoryProgress: vi.fn(),
  runGhostSessionHistory: vi.fn(),
}));

const key = {
  userId: "00000000-0000-4000-8000-000000000001",
  activityId: "00000000-0000-4000-8000-000000000002",
};
const database = createDatabase("postgresql://unused:unused@localhost:1/unused");
const client: ClickHouseClient = { command: vi.fn(), exec: vi.fn(), query: vi.fn() };
const owner: AnalyticsQueryOwner = {
  client: { ...client, insert: vi.fn() },
  ingestedAt: "2026-11-24T20:00:00.000000Z",
  reserveIngestionThrough: vi.fn(),
  reuseIngestionReservation: vi.fn(),
  assertActive: vi.fn(),
  runSynchronousDbt: vi.fn(),
  runSynchronousRequest: vi.fn(),
};
const consentRevision = "2026-11-24T11:00:00.000002Z";
const sourceVersion = "current-source-version";

function readyRecording(startedAt = "2026-11-24T12:00:00.000000Z", revision = consentRevision) {
  const stamp = {
    activityId: key.activityId,
    memberActivityId: "00000000-0000-4000-8000-000000000003",
    providerId: "direct",
    deviceId: null,
    sport: "running",
    modality: null,
    startedAt,
    endedAt: null,
    refreshVersion: "preview",
    sourceRefreshedAtNs: "1",
    memberSourceSyncedAtNs: null,
    gpsRefreshVersion: "1",
    gpsSourceRefreshedAtNs: "1",
    memberSignature: "members",
  } satisfies Omit<
    NonNullable<Awaited<ReturnType<typeof readGhostRouteLabelsInput>>>["source"],
    "status" | "markerSignature"
  >;
  vi.mocked(getGhostSessionHistoryProgress).mockResolvedValue({
    anchorStatus: "ready",
    anchorGeneration: createHash("sha256").update(JSON.stringify(stamp)).digest("hex"),
    historyGeneration: "history",
    nextCursor: null,
    auditCursor: null,
    sourceHistoryCoverage: "complete",
    historyCoverage: "complete",
    comparisonLimited: false,
    refreshVersion: "1",
    finished: true,
  });
  const input = {
    source: { ...stamp, status: "ready" as const, markerSignature: null },
    sourceVersion,
    consentRevision: revision,
  };
  vi.mocked(readGhostRouteLabelsInput).mockResolvedValue(input);
  return input;
}

function run(ordinary = vi.fn(async () => {})) {
  return runAnalyticsWithGhostHistory(database, client, "test-publication", ordinary);
}

let ghostOwnerOpen = false;
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-24T20:00:00.000Z"));
  vi.stubEnv("GHOST_MAP_LABELS_REGION", "eu");
  vi.mocked(withAnalyticsQueryOwner).mockImplementation(
    async (_database, _client, input, operation) => {
      if (input.resourceId === ANALYTICS_PUBLICATION_RESOURCE) return operation(owner);
      ghostOwnerOpen = true;
      try {
        return await operation(owner);
      } finally {
        ghostOwnerOpen = false;
      }
    },
  );
  vi.mocked(withAccountErasureUserWriteFence).mockImplementation(
    async (_database, _userId, operation) => operation(database),
  );
  vi.mocked(runGhostSessionHistory).mockResolvedValue({
    pendingTracks: 0,
    checkedAnchors: 1,
    checkedAnchorKeys: [key],
  });
  readyRecording();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
afterAll(() => database.$client.end());

describe("automatic Ghost route label publication", () => {
  it.each([undefined, "disabled"])("does no label work for region %s", async (region) => {
    vi.stubEnv("GHOST_MAP_LABELS_REGION", region);
    const ordinary = vi.fn(async () => {});
    await run(ordinary);
    expect(ordinary).toHaveBeenCalledOnce();
    expect(runGhostSessionHistory).toHaveBeenCalledOnce();
    expect(getGhostSessionHistoryProgress).not.toHaveBeenCalled();
    expect(readGhostRouteLabelsCache).not.toHaveBeenCalled();
    expect(enqueueGhostRouteLabels).not.toHaveBeenCalled();
  });

  it("requires an accepted pointer and exact current source", async () => {
    vi.mocked(getGhostSessionHistoryProgress).mockResolvedValueOnce(null);
    await run();
    expect(readGhostRouteLabelsInput).not.toHaveBeenCalled();
    const input = readyRecording();
    vi.mocked(readGhostRouteLabelsInput).mockResolvedValue({
      ...input,
      source: { ...input.source, refreshVersion: "replaced" },
    });
    await run();
    expect(readGhostRouteLabelsCache).not.toHaveBeenCalled();
    expect(enqueueGhostRouteLabels).not.toHaveBeenCalled();
  });

  it("skips a source without live consent", async () => {
    vi.mocked(readGhostRouteLabelsInput).mockResolvedValue(null);
    await run();
    expect(readGhostRouteLabelsCache).not.toHaveBeenCalled();
    expect(enqueueGhostRouteLabels).not.toHaveBeenCalled();
  });

  it.each([
    ["before opt-in by one microsecond", "2026-11-24T11:00:00.000001Z", consentRevision],
    ["older than 24 hours", "2026-11-23T19:59:59.999999Z", "2026-11-22T20:00:00.000000Z"],
    ["in the future", "2026-11-24T20:00:00.000001Z", consentRevision],
  ])("skips a recording %s", async (_condition, startedAt, revision) => {
    readyRecording(startedAt, revision);
    await run();
    expect(readGhostRouteLabelsCache).not.toHaveBeenCalled();
    expect(enqueueGhostRouteLabels).not.toHaveBeenCalled();
  });

  it("skips an exact cached result", async () => {
    vi.mocked(readGhostRouteLabelsCache).mockResolvedValue({
      status: "error",
      reason: "request-failed",
    });
    await run();
    expect(readGhostRouteLabelsCache).toHaveBeenCalledWith(queryCache, {
      ...key,
      sourceVersion,
      consentRevision,
    });
    expect(enqueueGhostRouteLabels).not.toHaveBeenCalled();
  });

  it("queues a new recording only after owner close and within the erasure fence", async () => {
    readyRecording(consentRevision);
    let writeFenceOpen = false;
    vi.mocked(withAccountErasureUserWriteFence).mockImplementation(
      async (_database, userId, operation) => {
        expect(userId).toBe(key.userId);
        expect(ghostOwnerOpen).toBe(false);
        writeFenceOpen = true;
        try {
          return await operation(database);
        } finally {
          writeFenceOpen = false;
        }
      },
    );
    vi.mocked(enqueueGhostRouteLabels).mockImplementation(async () => {
      expect(writeFenceOpen).toBe(true);
    });
    await run();
    expect(enqueueGhostRouteLabels).toHaveBeenCalledExactlyOnceWith({
      ...key,
      sourceVersion,
      consentRevision,
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("keeps ordinary success on Redis failure and retries with the same label identity", async () => {
    const failure = new Error("queue offline");
    vi.mocked(enqueueGhostRouteLabels).mockRejectedValueOnce(failure);
    await expect(run()).resolves.toBeUndefined();
    expect(ghostOwnerOpen).toBe(false);
    expect(captureException).toHaveBeenCalledWith(failure, {
      tags: { source: "ghost-route-labels-publication" },
    });
    await run();
    const identity = { ...key, sourceVersion, consentRevision };
    expect(vi.mocked(enqueueGhostRouteLabels).mock.calls).toEqual([[identity], [identity]]);
  });
});
