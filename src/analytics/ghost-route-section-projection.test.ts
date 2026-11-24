import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMeasuredGhostScalarWindow } from "../db/activity-ghost-scalar-sample.ts";
import { getGhostTrack } from "../db/activity-ghost-track.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import {
  type GhostTrackEvidence,
  readGhostTrackEvidence,
  resolveActiveGhostMembers,
} from "../db/ghost-track-evidence.ts";
import type { Database } from "../db/index.ts";
import { preparedGhostSectionsSchema } from "../lib/ghost-route-section-results.ts";
import { type GhostTrackPoint, recordedGhostRouteChunks } from "./ghost-route-matching.ts";
import { prepareGhostSectionComparisons } from "./ghost-route-section-projection.ts";
import { listGhostTrackCandidates } from "./ghost-track-index.ts";

vi.mock("../db/activity-ghost-scalar-sample.ts", () => ({ getMeasuredGhostScalarWindow: vi.fn() }));
vi.mock("../db/activity-ghost-track.ts", () => ({ getGhostTrack: vi.fn() }));
vi.mock("../db/ghost-track-evidence.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/ghost-track-evidence.ts")>()),
  readGhostTrackEvidence: vi.fn(),
  resolveActiveGhostMembers: vi.fn(),
}));
vi.mock("./ghost-track-index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ghost-track-index.ts")>()),
  listGhostTrackCandidates: vi.fn(),
}));

const degreePerMeter = 180 / (Math.PI * 6_371_000);
const anchorEpoch = Date.parse("2026-11-24T08:00:00Z");
const candidateEpoch = Date.parse("2026-11-23T08:00:00Z");
const context: { db: Pick<Database, "execute">; clickhouse: Pick<ClickHouseClient, "query"> } = {
  db: { execute: vi.fn() },
  clickhouse: { query: vi.fn() },
};
const userId = id(1);

function id(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function line(firstMs: number, from: number, to: number, intervalMs = 1_000, step = 20) {
  return Array.from({ length: (to - from) / step + 1 }, (_, index) => ({
    timestampMs: firstMs + intervalMs * index,
    lat: 0,
    lng: (from + step * index) * degreePerMeter,
  }));
}

function recording(
  index: number,
  points: GhostTrackPoint[],
  startedAt = "2026-11-24T07:55:00.000111Z",
) {
  const stamp = {
    status: "ready" as const,
    activityId: id(index),
    memberActivityId: id(index + 200),
    providerId: "direct",
    deviceId: "recording-device",
    sport: "cycling" as const,
    modality: "outdoor",
    startedAt,
    endedAt: null,
    refreshVersion: "101",
    sourceRefreshedAtNs: "1111",
    memberSourceSyncedAtNs: null,
    gpsRefreshVersion: "122",
    gpsSourceRefreshedAtNs: "1333",
    memberSignature: "members",
    markerSignature: "source-marker",
  } satisfies GhostTrackEvidence;
  return { stamp, track: { ...stamp, points } };
}

function section(points: readonly GhostTrackPoint[], startIndex: number, endIndex: number) {
  const waypoints = recordedGhostRouteChunks(points).chunks.flat();
  const start = waypoints.find(({ originalIndex }) => originalIndex === startIndex);
  const end = waypoints.find(({ originalIndex }) => originalIndex === endIndex);
  if (!start || !end) throw new Error("Expected recorded section in fixture");
  return { start, end };
}

function named(points: readonly GhostTrackPoint[], startIndex: number, endIndex: number) {
  return {
    ...section(points, startIndex, endIndex),
    kind: "named-road" as const,
    name: "Example Road",
    attribution: "© OpenStreetMap contributors",
  };
}

function seedSourceReads(
  anchor: ReturnType<typeof recording>,
  candidates: ReturnType<typeof recording>[] = [],
) {
  const recordings = [anchor, ...candidates];
  const byId = new Map(recordings.map((source) => [source.stamp.activityId, source]));
  const evidence = new Map<string, GhostTrackEvidence>(
    recordings.map(({ stamp }) => [stamp.activityId, stamp]),
  );
  const active = new Map(recordings.map(({ stamp }) => [stamp.memberActivityId, stamp]));
  vi.mocked(listGhostTrackCandidates).mockResolvedValue({
    candidates: candidates.map(({ stamp, track }) => ({
      ...stamp,
      pointCount: track.points.length,
    })),
    nextCursor: null,
    historyCoverage: "unverified",
  });
  vi.mocked(readGhostTrackEvidence).mockImplementation(
    async (_query, keys) =>
      new Map([...evidence].filter(([activityId]) => keys.activityIds.includes(activityId))),
  );
  vi.mocked(resolveActiveGhostMembers).mockImplementation(
    async (_db, _userId, memberIds) =>
      new Map([...active].filter(([memberActivityId]) => memberIds.includes(memberActivityId))),
  );
  vi.mocked(getGhostTrack).mockImplementation(
    async (_client, { activityId }) => byId.get(activityId)?.track ?? { status: "missing" },
  );
  return { active, evidence };
}

function withoutScalarProof() {
  return { rawCount: 0, observationRows: [], proof: null };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getMeasuredGhostScalarWindow).mockResolvedValue(withoutScalarProof());
});

describe("prepareGhostSectionComparisons", () => {
  it("returns the display interval, actual timed overlap, workout date and scoped scalar proof", async () => {
    const anchor = recording(2, line(anchorEpoch + 0.125, 0, 400));
    const candidate = recording(
      3,
      line(candidateEpoch + 0.375, 140, 360, 1_500),
      "2026-11-23T07:52:00.000456Z",
    );
    seedSourceReads(anchor, [candidate]);
    vi.mocked(getMeasuredGhostScalarWindow).mockImplementation(async (_client, _userId, window) => {
      const isAnchor = window.activityId === anchor.stamp.activityId;
      const first = Date.parse(window.startedAt);
      const microseconds = isAnchor ? "125" : "375";
      const observationRows = Array.from(
        { length: isAnchor ? 9 : 14 },
        (_, index) =>
          [
            new Date(first + index * 1_000).toISOString().replace("Z", `${microseconds}Z`),
            "heart_rate",
            isAnchor ? 160 : 140,
            "measured",
          ] satisfies Awaited<
            ReturnType<typeof getMeasuredGhostScalarWindow>
          >["observationRows"][number],
      );
      return {
        rawCount: observationRows.length,
        observationRows,
        proof: { ...window, count: observationRows.length, digest: "A".repeat(64) },
      };
    });
    const input = { userId, anchor, sections: [named(anchor.track.points, 3, 16)] };
    const result = await prepareGhostSectionComparisons(context, input);
    expect(result).toMatchObject({
      status: "ready",
      anchorStamp: { activityId: anchor.stamp.activityId, markerSignature: "source-marker" },
      candidateStamps: [
        { activityId: candidate.stamp.activityId, markerSignature: "source-marker" },
      ],
      bounded: false,
      sections: [
        {
          kind: "named-road",
          name: "Example Road",
          historyCoverage: "partial",
          anchor: { start: { timestampMs: anchorEpoch + 3_000.125 }, elapsedMs: 13_000 },
          passes: [
            {
              activityId: candidate.stamp.activityId,
              startedAt: "2026-11-23T07:52:00.000456Z",
              comparison: {
                anchor: { start: { timestampMs: anchorEpoch + 7_000.125 }, elapsedMs: 9_000 },
                candidate: { start: { timestampMs: candidateEpoch + 0.375 }, elapsedMs: 13_500 },
                elapsedDifferenceMs: -4_500,
                replay: expect.any(Array),
                metrics: { heartRateBpm: { anchor: 160, candidate: 140 }, powerWatts: null },
              },
              scalarProof: [
                {
                  memberActivityId: anchor.stamp.memberActivityId,
                  startedAt: "2026-11-24T08:00:07.000125Z",
                  endedAt: "2026-11-24T08:00:16.000125Z",
                },
                {
                  memberActivityId: candidate.stamp.memberActivityId,
                  startedAt: "2026-11-23T08:00:00.000375Z",
                  endedAt: "2026-11-23T08:00:13.500375Z",
                },
              ],
            },
          ],
        },
      ],
    });
    const saved = preparedGhostSectionsSchema.parse(result);
    const again = preparedGhostSectionsSchema.parse(
      await prepareGhostSectionComparisons(context, input),
    );
    expect(again.sections[0]?.sectionId).toBe(saved.sections[0]?.sectionId);
    expect(again.sections[0]?.passes[0]?.passId).toBe(saved.sections[0]?.passes[0]?.passId);
    const comparison = saved.sections[0]?.passes[0]?.comparison;
    expect(comparison?.replay?.[0]).toEqual({
      anchor: comparison?.anchor.start,
      candidate: comparison?.candidate.start,
    });
    expect(comparison?.replay?.at(-1)).toEqual({
      anchor: comparison?.anchor.end,
      candidate: comparison?.candidate.end,
    });
    expect(getGhostTrack).toHaveBeenCalledWith(context.clickhouse, {
      userId,
      activityId: candidate.stamp.activityId,
    });
  });

  it("uses only raw vertices, keeps geometry endpoints and rejects labels spanning a GPS gap", async () => {
    const points = [
      ...line(anchorEpoch, 0, 120, 1_000, 3),
      ...line(anchorEpoch + 60_000, 180, 540, 1_000, 3),
    ];
    const anchor = recording(2, points);
    seedSourceReads(anchor);
    const result = await prepareGhostSectionComparisons(context, {
      userId,
      anchor,
      sections: [named(points, 0, 160), { ...section(points, 41, 160), kind: "unnamed-climb" }],
    });
    expect(result).toMatchObject({
      status: "ready",
      sections: [{ kind: "unnamed-climb", passes: [] }],
    });
    const prepared = preparedGhostSectionsSchema.parse(result);
    const geometry = prepared.sections[0]?.geometry?.[0];
    expect(geometry).toHaveLength(96);
    expect(geometry?.[0]).toEqual({ lat: 0, lng: 180 * degreePerMeter });
    expect(geometry?.at(-1)).toEqual({ lat: 0, lng: 537 * degreePerMeter });
    const retained = new Set(points.slice(41, 161).map(({ lng }) => lng));
    expect(geometry?.every(({ lng }) => retained.has(lng))).toBe(true);
  });

  it("keeps four latest distinct self passes and caps scalar work without dropping timing", async () => {
    const points = Array.from({ length: 111 }, (_, index) => {
      const leg = index % 20;
      return {
        timestampMs: anchorEpoch + index * 1_000,
        lat: 0,
        lng: (leg <= 10 ? leg : 20 - leg) * 20 * degreePerMeter,
      };
    });
    const anchor = recording(2, points);
    seedSourceReads(anchor);
    vi.mocked(getMeasuredGhostScalarWindow).mockImplementation(
      async (_client, _owner, _window, fetchLimit) => ({
        ...withoutScalarProof(),
        rawCount: fetchLimit,
      }),
    );
    const result = await prepareGhostSectionComparisons(context, {
      userId,
      anchor,
      sections: [named(points, 100, 110)],
    });
    expect(result).toMatchObject({ status: "ready", bounded: true, candidateStamps: [] });
    const saved = preparedGhostSectionsSchema.parse(result);
    const passes = saved.sections[0]?.passes;
    expect(passes?.map(({ comparison }) => comparison.candidate.start.timestampMs)).toEqual(
      [80_000, 60_000, 40_000, 20_000].map((delta) => anchorEpoch + delta),
    );
    expect(new Set(passes?.map(({ passId }) => passId)).size).toBe(4);
    expect(
      passes?.every(
        ({ activityId, comparison, scalarProof }) =>
          activityId === anchor.stamp.activityId &&
          comparison.candidate.elapsedMs === 10_000 &&
          comparison.metrics.heartRateBpm === null &&
          comparison.metrics.powerWatts === null &&
          scalarProof.length === 0 &&
          comparison.replay !== null,
      ),
    ).toBe(true);
    expect(vi.mocked(getMeasuredGhostScalarWindow).mock.calls.map((call) => call[3])).toEqual([
      4_001, 4_001, 4_001, 4_001, 3_996,
    ]);
    expect(getGhostTrack).not.toHaveBeenCalled();
  });

  it("reuses at most eight candidate tracks across eight sections and sorts by traversal time", async () => {
    const anchor = recording(2, line(anchorEpoch, 0, 400));
    const candidates = Array.from({ length: 9 }, (_, index) =>
      recording(
        index + 3,
        line(candidateEpoch + index * 100_000, 0, 400),
        `2026-11-${23 - index}T07:52:00.000456Z`,
      ),
    );
    seedSourceReads(anchor, candidates);
    const sections = Array.from({ length: 10 }, (_, index) =>
      named(anchor.track.points, index, index + 10),
    );
    const result = await prepareGhostSectionComparisons(context, {
      userId,
      anchor,
      sections: sections.reverse(),
    });
    expect(result).toMatchObject({ status: "ready", bounded: true });
    const prepared = preparedGhostSectionsSchema.parse(result);
    expect(prepared.sections).toHaveLength(8);
    expect(prepared.sections[0]?.anchor.start.timestampMs).toBe(anchorEpoch);
    expect(
      prepared.sections.every(
        ({ historyCoverage, passes }) =>
          historyCoverage === "partial" &&
          passes.map(({ activityId }) => activityId).join(",") ===
            [id(10), id(9), id(8), id(7)].join(","),
      ),
    ).toBe(true);
    expect(listGhostTrackCandidates).toHaveBeenCalledTimes(1);
    expect(getGhostTrack).toHaveBeenCalledTimes(8);
    expect(getGhostTrack).not.toHaveBeenCalledWith(context.clickhouse, {
      userId,
      activityId: id(11),
    });
  });

  it("omits candidates that fail current selected-member and loaded recording checks", async () => {
    const anchor = recording(2, line(anchorEpoch, 0, 400));
    const inactive = recording(3, line(candidateEpoch, 0, 400), "2026-11-23T07:52:00.000456Z");
    const replaced = recording(4, line(candidateEpoch, 0, 400), "2026-11-23T07:51:00.000456Z");
    const { active } = seedSourceReads(anchor, [inactive, replaced]);
    active.delete(inactive.stamp.memberActivityId);
    vi.mocked(getGhostTrack).mockResolvedValue({ ...replaced.track, refreshVersion: "replaced" });
    const result = await prepareGhostSectionComparisons(context, {
      userId,
      anchor,
      sections: [named(anchor.track.points, 0, 10)],
    });
    expect(result).toMatchObject({
      status: "ready",
      bounded: true,
      candidateStamps: [],
      sections: [{ historyCoverage: "partial", passes: [] }],
    });
    expect(getGhostTrack).toHaveBeenCalledTimes(1);
    expect(getGhostTrack).toHaveBeenCalledWith(context.clickhouse, {
      userId,
      activityId: replaced.stamp.activityId,
    });
    expect(getMeasuredGhostScalarWindow).not.toHaveBeenCalled();
  });

  it("rejects an anchor that changed before work and a used candidate that changed during preparation", async () => {
    const anchor = recording(2, line(anchorEpoch, 0, 400));
    const candidate = recording(3, line(candidateEpoch, 0, 400), "2026-11-23T07:52:00.000456Z");
    const { evidence } = seedSourceReads(anchor, [candidate]);
    const input = { userId, anchor, sections: [named(anchor.track.points, 0, 10)] };
    evidence.set(anchor.stamp.activityId, {
      ...anchor.stamp,
      markerSignature: "new-anchor-marker",
    });
    expect(await prepareGhostSectionComparisons(context, input)).toEqual({ status: "stale" });
    expect(getGhostTrack).not.toHaveBeenCalled();
    evidence.set(anchor.stamp.activityId, anchor.stamp);
    vi.mocked(getMeasuredGhostScalarWindow).mockImplementation(async () => {
      evidence.set(candidate.stamp.activityId, {
        ...candidate.stamp,
        markerSignature: "new-candidate-marker",
      });
      return withoutScalarProof();
    });
    expect(await prepareGhostSectionComparisons(context, input)).toEqual({ status: "stale" });
    expect(getGhostTrack).toHaveBeenCalledTimes(1);
  });
});
