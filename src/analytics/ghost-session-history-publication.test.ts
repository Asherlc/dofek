import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withAccountErasureUserWriteFence } from "../db/account-erasure.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { readGhostMapLabelConsent } from "../db/ghost-map-label-consent.ts";
import { createDatabase } from "../db/index.ts";
import { readGhostRouteInput } from "../jobs/process-ghost-route-labels-job.ts";
import { enqueueGhostRouteClimbs, enqueueGhostRouteLabels } from "../jobs/queues.ts";
import { queryCache } from "../lib/cache.ts";
import { captureException } from "../lib/error-reporting.ts";
import { readGhostRouteClimbsCache } from "../lib/ghost-route-climbs-cache.ts";
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
vi.mock("../db/ghost-map-label-consent.ts", () => ({ readGhostMapLabelConsent: vi.fn() }));
vi.mock("../jobs/process-ghost-route-labels-job.ts", () => ({
  readGhostRouteInput: vi.fn(),
}));
vi.mock("../jobs/queues.ts", () => ({
  enqueueGhostRouteLabels: vi.fn(),
  enqueueGhostRouteClimbs: vi.fn(),
}));
vi.mock("../lib/cache.ts", () => ({ queryCache: { get: vi.fn() } }));
vi.mock("../lib/error-reporting.ts", () => ({ captureException: vi.fn() }));
vi.mock("../lib/ghost-route-climbs-cache.ts", () => ({ readGhostRouteClimbsCache: vi.fn() }));
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
const sourceVersion = "a".repeat(64);
const climbRevision = { ...key, sourceVersion };

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
    NonNullable<Awaited<ReturnType<typeof readGhostRouteInput>>>["source"],
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
  vi.mocked(readGhostRouteInput).mockResolvedValue({
    source: input.source,
    sourceVersion: input.sourceVersion,
  });
  vi.mocked(readGhostMapLabelConsent).mockResolvedValue({ revision });
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

describe("automatic Ghost section publication", () => {
  it.each([undefined, "disabled"])(
    "queues climbs without label work for region %s",
    async (region) => {
      vi.stubEnv("GHOST_MAP_LABELS_REGION", region);
      const ordinary = vi.fn(async () => {});
      await run(ordinary);
      expect(ordinary).toHaveBeenCalledOnce();
      expect(runGhostSessionHistory).toHaveBeenCalledOnce();
      expect(getGhostSessionHistoryProgress).toHaveBeenCalledExactlyOnceWith(client, key);
      expect(readGhostRouteInput).toHaveBeenCalledExactlyOnceWith(database, client, key);
      expect(readGhostMapLabelConsent).not.toHaveBeenCalled();
      expect(readGhostRouteLabelsCache).not.toHaveBeenCalled();
      expect(enqueueGhostRouteLabels).not.toHaveBeenCalled();
      expect(enqueueGhostRouteClimbs).toHaveBeenCalledExactlyOnceWith(climbRevision);
    },
  );

  it("requires an accepted pointer and exact current source", async () => {
    vi.mocked(getGhostSessionHistoryProgress).mockResolvedValueOnce(null);
    await run();
    expect(readGhostRouteInput).not.toHaveBeenCalled();
    const input = readyRecording();
    vi.mocked(readGhostRouteInput).mockResolvedValue({
      sourceVersion: input.sourceVersion,
      source: { ...input.source, refreshVersion: "replaced" },
    });
    await run();
    expect(readGhostRouteLabelsCache).not.toHaveBeenCalled();
    expect(enqueueGhostRouteLabels).not.toHaveBeenCalled();
    expect(readGhostRouteClimbsCache).not.toHaveBeenCalled();
    expect(enqueueGhostRouteClimbs).not.toHaveBeenCalled();
  });

  it("queues climbs for a current source without map consent", async () => {
    vi.mocked(readGhostMapLabelConsent).mockResolvedValue(null);
    await run();
    expect(readGhostRouteLabelsCache).not.toHaveBeenCalled();
    expect(enqueueGhostRouteLabels).not.toHaveBeenCalled();
    expect(enqueueGhostRouteClimbs).toHaveBeenCalledExactlyOnceWith(climbRevision);
  });

  it("keeps climbs independent of the exact label opt-in cutoff", async () => {
    readyRecording("2026-11-24T11:00:00.000001Z");
    await run();
    expect(readGhostRouteLabelsCache).not.toHaveBeenCalled();
    expect(enqueueGhostRouteLabels).not.toHaveBeenCalled();
    expect(enqueueGhostRouteClimbs).toHaveBeenCalledExactlyOnceWith(climbRevision);
  });

  it.each([
    ["older than 24 hours", "2026-11-23T19:59:59.999999Z", "2026-11-22T20:00:00.000000Z"],
    ["in the future", "2026-11-24T20:00:00.000001Z", consentRevision],
  ])("skips a recording %s", async (_condition, startedAt, revision) => {
    readyRecording(startedAt, revision);
    await run();
    expect(readGhostRouteLabelsCache).not.toHaveBeenCalled();
    expect(enqueueGhostRouteLabels).not.toHaveBeenCalled();
    expect(readGhostRouteClimbsCache).not.toHaveBeenCalled();
    expect(enqueueGhostRouteClimbs).not.toHaveBeenCalled();
  });

  it("accepts the exact lower edge of the 24-hour window", async () => {
    readyRecording("2026-11-23T20:00:00.000000Z", "2026-11-22T20:00:00.000000Z");
    await run();
    expect(enqueueGhostRouteClimbs).toHaveBeenCalledExactlyOnceWith(climbRevision);
    expect(enqueueGhostRouteLabels).toHaveBeenCalledOnce();
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
    expect(enqueueGhostRouteClimbs).toHaveBeenCalledExactlyOnceWith(climbRevision);
  });

  it("queues both producers from one source check after owner close and within the erasure fence", async () => {
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
    vi.mocked(enqueueGhostRouteClimbs).mockImplementation(async () => {
      expect(writeFenceOpen).toBe(true);
    });
    await run();
    expect(readGhostRouteInput).toHaveBeenCalledExactlyOnceWith(database, client, key);
    expect(readGhostMapLabelConsent).toHaveBeenCalledExactlyOnceWith(database, key.userId);
    expect(enqueueGhostRouteClimbs).toHaveBeenCalledExactlyOnceWith(climbRevision);
    expect(enqueueGhostRouteLabels).toHaveBeenCalledExactlyOnceWith({
      ...key,
      sourceVersion,
      consentRevision,
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("does not enqueue either branch if the owner write fence rejects", async () => {
    vi.mocked(withAccountErasureUserWriteFence).mockRejectedValueOnce(
      new Error("erasure in progress"),
    );
    await expect(run()).resolves.toBeUndefined();
    expect(readGhostRouteInput).not.toHaveBeenCalled();
    expect(enqueueGhostRouteClimbs).not.toHaveBeenCalled();
    expect(enqueueGhostRouteLabels).not.toHaveBeenCalled();
  });

  it("deduplicates an exact climb cache hit even when there are no climbs", async () => {
    const { source } = readyRecording();
    const { status: _ready, ...anchorStamp } = source;
    vi.mocked(readGhostRouteClimbsCache).mockResolvedValue({
      status: "ready",
      altitudeProof: {
        activityId: key.activityId,
        memberActivityId: source.memberActivityId,
        providerId: source.providerId,
        deviceId: source.deviceId,
        startedAt: "2026-11-24T12:00:00.000000Z",
        endedAt: "2026-11-24T12:01:00.000000Z",
        count: 0,
        digest: "4F53CDA18C2BAA0C0354BB5F9A3ECBE5ED12AB4D8E11BA873C2F11161202B945",
      },
      prepared: { status: "ready", anchorStamp, candidateStamps: [], bounded: false, sections: [] },
    });
    await run();
    expect(readGhostRouteClimbsCache).toHaveBeenCalledExactlyOnceWith(queryCache, climbRevision);
    expect(enqueueGhostRouteClimbs).not.toHaveBeenCalled();
    expect(enqueueGhostRouteLabels).toHaveBeenCalledOnce();
  });

  it.each([
    ["active names only", 1, true, true, false],
    ["legacy names only", undefined, true, false, false],
    ["expired names only", 0, true, false, false],
    ["empty names only", 1, false, false, false],
    ["prepared names", 1, true, false, true],
  ] as const)(
    "uses the original deadline and missing preparation for %s",
    async (_condition, remainingMs, hasSections, shouldRetry, hasPrepared) => {
      const { source } = readyRecording();
      const { status: _ready, ...anchorStamp } = source;
      const start = { originalIndex: 0, timestampMs: 0, lat: 0, lng: 0, distanceMeters: 0 };
      const end = {
        originalIndex: 1,
        timestampMs: 50_000,
        lat: 0,
        lng: 0.002,
        distanceMeters: 200,
      };
      vi.mocked(readGhostRouteLabelsCache).mockResolvedValue({
        status: "ready",
        sections: hasSections
          ? [
              {
                kind: "named-road",
                name: "Example Road",
                attribution: "OpenStreetMap",
                start,
                end,
              },
            ]
          : [],
        coverage: { sampledWaypoints: 10, confirmedWaypoints: 10, bounded: false },
        ...(remainingMs === undefined ? {} : { expiresAt: Date.now() + remainingMs }),
        ...(hasPrepared
          ? {
              prepared: {
                status: "ready",
                anchorStamp,
                candidateStamps: [],
                bounded: false,
                sections: [],
              },
            }
          : {}),
      });
      await run();
      expect(enqueueGhostRouteLabels).toHaveBeenCalledTimes(shouldRetry ? 1 : 0);
      if (shouldRetry)
        expect(enqueueGhostRouteLabels).toHaveBeenCalledWith({
          ...climbRevision,
          consentRevision,
          prepareOnly: true,
        });
      expect(enqueueGhostRouteClimbs).toHaveBeenCalledOnce();
    },
  );

  it("keeps named scheduling and ordinary success when the climb branch fails", async () => {
    const failure = new Error("climb queue offline");
    vi.mocked(enqueueGhostRouteClimbs).mockRejectedValueOnce(failure);
    await expect(run()).resolves.toBeUndefined();
    expect(enqueueGhostRouteClimbs).toHaveBeenCalledExactlyOnceWith(climbRevision);
    expect(enqueueGhostRouteLabels).toHaveBeenCalledOnce();
    expect(captureException).toHaveBeenCalledWith(failure, {
      tags: { source: "ghost-route-climbs-publication" },
    });
  });

  it("keeps ordinary success on Redis failure and retries with the same label identity", async () => {
    const failure = new Error("queue offline");
    vi.mocked(enqueueGhostRouteLabels).mockRejectedValueOnce(failure);
    await expect(run()).resolves.toBeUndefined();
    expect(ghostOwnerOpen).toBe(false);
    expect(enqueueGhostRouteClimbs).toHaveBeenCalledOnce();
    expect(captureException).toHaveBeenCalledWith(failure, {
      tags: { source: "ghost-route-labels-publication" },
    });
    await run();
    const identity = { ...key, sourceVersion, consentRevision };
    expect(vi.mocked(enqueueGhostRouteLabels).mock.calls).toEqual([[identity], [identity]]);
  });
});
