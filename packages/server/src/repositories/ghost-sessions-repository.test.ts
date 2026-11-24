import type { GhostSessionsCompareResponse } from "@dofek/training/ghost-sessions";
import { createDatabase } from "dofek/db";
import { withAccountErasureUserWriteFence } from "dofek/db/account-erasure";
import { readGhostMapLabelConsent } from "dofek/db/ghost-map-label-consent";
import { ghostRouteLabelsSourceVersion } from "dofek/db/ghost-track-evidence";
import { enqueueGhostRouteLabels } from "dofek/jobs/queues";
import { queryCache } from "dofek/lib/cache";
import { captureException } from "dofek/lib/error-reporting";
import { ghostRouteLabelsCacheKey } from "dofek/lib/ghost-route-labels-cache";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AccessWindow } from "../billing/entitlement.ts";
import { ActivityRepository } from "./activity-repository.ts";
import type { ActivitySensorQueryStore } from "./activity-sensor-types.ts";
import {
  createGhostSessionsRepository,
  GhostSessionsRepository,
} from "./ghost-sessions-repository.ts";

vi.mock("dofek/db/account-erasure", async (importOriginal) => ({
  ...(await importOriginal<typeof import("dofek/db/account-erasure")>()),
  withAccountErasureUserWriteFence: vi.fn(),
}));
vi.mock("dofek/db/ghost-map-label-consent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("dofek/db/ghost-map-label-consent")>()),
  readGhostMapLabelConsent: vi.fn(),
}));
vi.mock("dofek/jobs/queues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("dofek/jobs/queues")>()),
  enqueueGhostRouteLabels: vi.fn(),
}));
vi.mock("dofek/lib/error-reporting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("dofek/lib/error-reporting")>()),
  captureException: vi.fn(),
}));

type Dependencies = ConstructorParameters<typeof GhostSessionsRepository>[0];
type ReadyAnchor = Extract<
  Awaited<ReturnType<Dependencies["reads"]["readAnchor"]>>,
  { status: "ready" }
>;
type SavedMatch = ReadyAnchor["matches"][number];

function activityId(number: number) {
  return `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

const owner = activityId(1);
const anchorId = activityId(2);
const aliasId = activityId(3);
const anchorStart = Date.UTC(2026, 10, 24, 12);
const oldStart = Date.UTC(2026, 10, 23, 12);
const database = createDatabase("postgresql://unused:unused@localhost:1/unused");
const consentRevision = "2026-11-25T10:00:00.000001Z";
const limitedWindow: AccessWindow = {
  kind: "limited",
  paid: false,
  reason: "free_recent_week",
  startDate: "2026-11-18",
  endDateExclusive: "2026-11-25",
};

function interval(startMs: number, elapsedMs: number) {
  return {
    start: { timestampMs: startMs, distanceMeters: 0, lat: 37, lng: -122 },
    end: { timestampMs: startMs + elapsedMs, distanceMeters: 500, lat: 37.003, lng: -122 },
    elapsedMs,
  };
}

const wholeRoute = interval(anchorStart, 60_000);
const shiftedRoute = interval(anchorStart + 2_000, 54_000);
const originalWorkoutStart = new Date(oldStart).toISOString();
const geometry = [
  [
    { lat: 37, lng: -122 },
    { lat: 37.003, lng: -122 },
  ],
];

function selectedMember(activityId: string, memberActivityId = activityId) {
  return { activityId, memberActivityId, providerId: "direct" };
}

function match(overrides: Partial<SavedMatch> = {}): SavedMatch {
  return {
    sectionId: "projected-full-route",
    passId: "previous-best",
    kind: "full-route",
    anchor: wholeRoute,
    activityId: activityId(10),
    startedAt: originalWorkoutStart,
    passStartedAtMs: oldStart,
    passEndedAtMs: oldStart + 65_000,
    elapsedMs: 65_000,
    page: {
      anchorGeneration: "anchor",
      historyGeneration: "history",
      frontier: "",
      requestCursor: "",
    },
    anchorStamp: "anchor-stamp",
    candidateStamp: "candidate-stamp",
    source: selectedMember(overrides.activityId ?? activityId(10)),
    ...overrides,
  };
}

function fixture(
  matches: readonly SavedMatch[] = [],
  options: {
    accessWindow?: AccessWindow;
    hidden?: Set<string>;
    checkedActivityIds?: string[];
    ownerId?: string;
    historyCoverage?: "partial" | "complete";
    generation?: string;
  } = {},
) {
  const hidden = options.hidden ?? new Set<string>();
  const ownerId = options.ownerId ?? owner;
  const activeMembers = new Map(
    [selectedMember(anchorId, aliasId), ...matches.map(({ source }) => source)].map((member) => [
      member.memberActivityId,
      member,
    ]),
  );
  const activity = {
    findSensorWindow: vi.fn<Dependencies["activity"]["findSensorWindow"]>(async (id) =>
      id === aliasId || id === anchorId
        ? {
            activityId: anchorId,
            userId: ownerId,
            memberActivityIds: [aliasId],
            providerType: "ordinary copy has unrelated type",
            startedAt: new Date(anchorStart).toISOString(),
            endedAt: new Date(anchorStart + wholeRoute.elapsedMs).toISOString(),
          }
        : null,
    ),
    resolveVisibleActivityIds: vi.fn<Dependencies["activity"]["resolveVisibleActivityIds"]>(
      async (ids) => new Set(ids.filter((id) => !hidden.has(id))),
    ),
  };
  const reads = {
    readAnchor: vi.fn<Dependencies["reads"]["readAnchor"]>().mockResolvedValue({
      status: "ready",
      sport: "running",
      gpsCoverage: "complete",
      anchor: wholeRoute,
      geometry,
      source: {
        ...track(anchorId, aliasId, new Date(anchorStart).toISOString()),
        status: "ready",
        markerSignature: null,
      },
      generation: options.generation ?? "current-generation",
      historyCoverage: options.historyCoverage ?? "complete",
      checkedActivityIds: options.checkedActivityIds ?? matches.map(({ activityId }) => activityId),
      matches,
    }),
    readComparison: vi.fn<Dependencies["reads"]["readComparison"]>(),
    readLabels: vi
      .fn<Dependencies["reads"]["readLabels"]>()
      .mockResolvedValue({ status: "disabled" }),
  };
  const repository = new GhostSessionsRepository({
    ownerId,
    timezone: "UTC",
    accessWindow: options.accessWindow ?? { kind: "full", paid: true, reason: "paid_grant" },
    reads,
    activity,
    resolveActiveMembers: async (memberIds) =>
      new Map([...activeMembers].filter(([memberId]) => memberIds.includes(memberId))),
  });
  return { repository, activity, reads, hidden, activeMembers };
}

function track(groupId: string, memberId: string, startedAt: string) {
  return {
    ...selectedMember(groupId, memberId),
    deviceId: null,
    sport: "running" as const,
    modality: null,
    startedAt,
    endedAt: null,
    refreshVersion: "1",
    sourceRefreshedAtNs: "1",
    memberSourceSyncedAtNs: null,
    gpsRefreshVersion: "1",
    gpsSourceRefreshedAtNs: "1",
    memberSignature: `source-${groupId}`,
  };
}

function publicationFixture() {
  const anchor = track(anchorId, aliasId, new Date(anchorStart).toISOString());
  const candidates = Array.from({ length: 22 }, (_, index) =>
    track(activityId(10 + index), activityId(100 + index), originalWorkoutStart),
  );
  const tracks = [anchor, ...candidates];
  const state: {
    historyGeneration: string;
    frontier: string | null;
    version: string;
    digest: string;
    beforeReplay: () => void;
    scalarCurrent: boolean;
    staleTrack?: string;
    activeAnchor: boolean;
    markerSignature: string;
  } = {
    historyGeneration: "history",
    frontier: null,
    version: "7",
    digest: "original",
    beforeReplay: () => {},
    scalarCurrent: true,
    activeAnchor: true,
    markerSignature: "current-marker",
  };
  const recordedPass = interval(oldStart, 65_000);
  const comparison: GhostSessionsCompareResponse = {
    anchor: wholeRoute,
    candidate: recordedPass,
    elapsedDifferenceMs: -5_000,
    timeBasis: "elapsed-including-recorded-stops",
    replay: [
      { anchor: wholeRoute.start, candidate: recordedPass.start },
      { anchor: wholeRoute.end, candidate: recordedPass.end },
    ],
    replayDownsampled: false,
    metrics: {
      paceSecondsPerKm: null,
      heartRateBpm: { anchor: 145, candidate: 150 },
      powerWatts: null,
    },
  };
  const compactMatches = candidates.map((candidate, index) => [
    "physical-route",
    `pass-${String(index).padStart(2, "0")}`,
    "full-route",
    JSON.stringify(wholeRoute),
    candidate.activityId,
    originalWorkoutStart,
    oldStart,
    oldStart + 65_000,
    65_000,
    JSON.stringify(candidate),
  ]);
  const sensorStore: ActivitySensorQueryStore = {
    async query(schema, _query, params = {}) {
      if (params.activityIds)
        return schema.array().parse(
          tracks.map((record) => ({
            ...record,
            markerSignature: state.markerSignature,
            status: record.activityId === state.staleTrack ? "pending" : "ready",
          })),
        );
      if (params.pointerVersion)
        return schema.array().parse([
          {
            requestCursor: "",
            nextCursor: state.frontier,
            anchorStamp: JSON.stringify(anchor),
            anchorSummary: JSON.stringify({
              gpsCoverage: "complete",
              anchor: wholeRoute,
              geometry,
            }),
            bounded: 0,
            matches: compactMatches,
            digest: state.digest,
            version: state.version,
          },
        ]);
      if (params.passId) {
        state.beforeReplay();
        const selected = candidates[0];
        if (
          !selected ||
          params.passId !== "pass-00" ||
          params.sectionId !== "physical-route" ||
          params.requestCursor !== "" ||
          params.historyGeneration !== state.historyGeneration ||
          params.frontier !== (state.frontier ?? "") ||
          params.anchorStamp !== JSON.stringify(anchor) ||
          params.candidateStamp !== JSON.stringify(selected) ||
          params.candidateActivityId !== selected.activityId ||
          (params.version !== undefined && params.version !== state.version) ||
          (params.digest !== undefined && params.digest !== state.digest)
        )
          return [];
        return schema.array().parse([
          {
            comparison: JSON.stringify(comparison),
            scalarProof: JSON.stringify(
              [anchor, selected].map((track, index) => ({
                activityId: track.activityId,
                memberActivityId: track.memberActivityId,
                startedAt: track.startedAt,
                endedAt: new Date(
                  index === 0 ? wholeRoute.end.timestampMs : recordedPass.end.timestampMs,
                ).toISOString(),
                count: 1,
                digest: `scalar-${index}`,
              })),
            ),
          },
        ]);
      }
      if (params.windows)
        return schema.array().parse(
          [0, 1].map((windowId) => ({
            windowId,
            count: 1,
            digest: state.scalarCurrent ? `scalar-${windowId}` : "changed",
          })),
        );
      return schema.array().parse([
        {
          anchorGeneration: "anchor",
          historyGeneration: state.historyGeneration,
          nextCursor: state.frontier,
          status: "ready",
          sourceCoverage: "partial",
          historyCoverage: "partial",
          comparisonLimited: 0,
          version: "9",
        },
      ]);
    },
  };
  const { activity } = fixture();
  vi.spyOn(ActivityRepository.prototype, "findSensorWindow").mockImplementation(
    activity.findSensorWindow,
  );
  vi.spyOn(ActivityRepository.prototype, "resolveVisibleActivityIds").mockImplementation(
    activity.resolveVisibleActivityIds,
  );
  vi.spyOn(database, "execute").mockImplementation(async () =>
    tracks.filter((record) => state.activeAnchor || record.activityId !== anchorId),
  );
  const repository = createGhostSessionsRepository({
    db: database,
    userId: owner,
    timezone: "UTC",
    accessWindow: { kind: "full", paid: true, reason: "paid_grant" },
    sensorStore,
  });
  return {
    repository,
    state,
    comparison,
    candidateId: candidates[0]?.activityId,
    scope: { activityId: anchorId, sectionId: `route:${anchorId}` },
    anchor,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(readGhostMapLabelConsent).mockReset();
  vi.mocked(withAccountErasureUserWriteFence).mockReset();
  vi.mocked(enqueueGhostRouteLabels).mockReset();
  vi.mocked(captureException).mockReset();
});
afterAll(() => database.$client.end());

function labelFixture() {
  const { repository, state, anchor } = publicationFixture();
  const enqueue = vi.mocked(enqueueGhostRouteLabels).mockResolvedValue(undefined);
  const consent = vi
    .mocked(readGhostMapLabelConsent)
    .mockResolvedValue({ revision: consentRevision });
  const fence = vi
    .mocked(withAccountErasureUserWriteFence)
    .mockImplementation(async (_db, _owner, operation) => operation(database));
  const cache = vi.spyOn(queryCache, "get").mockResolvedValue(undefined);
  vi.stubEnv("GHOST_MAP_LABELS_REGION", "eu");
  const readyEvidence = {
    ...anchor,
    markerSignature: state.markerSignature,
    status: "ready" as const,
  };
  const identity = {
    userId: owner,
    activityId: anchorId,
    sourceVersion: ghostRouteLabelsSourceVersion(readyEvidence),
    consentRevision,
  };
  const segment = {
    kind: "named-trail",
    name: "Recorded trail",
    attribution: "© OpenStreetMap contributors · Powered by Geoapify",
    start: {
      ...wholeRoute.start,
      timestampMs: anchorStart + 2_000,
      distanceMeters: 20,
      originalIndex: 1,
    },
    end: {
      ...wholeRoute.end,
      timestampMs: anchorStart + 42_000,
      distanceMeters: 300,
      originalIndex: 19,
    },
  };
  const coverage = { sampledWaypoints: 20, confirmedWaypoints: 18, bounded: false };
  const result = { status: "ready", sections: [segment], coverage };
  const input = { activityId: aliasId };
  return { repository, state, enqueue, consent, fence, cache, identity, segment, result, input };
}

describe("GhostSessionsRepository", () => {
  it("keeps base timing and queues an older canonical activity on the exact cache miss", async () => {
    const { repository, input, identity, enqueue, fence, cache } = labelFixture();
    await expect(repository.get(input)).resolves.toMatchObject({
      availability: "ready",
      nameStatus: "processing",
      historyCoverage: "partial",
      sections: [{ kind: "route", anchor: wholeRoute }],
    });
    expect(cache).toHaveBeenCalledExactlyOnceWith(ghostRouteLabelsCacheKey(identity));
    expect(fence).toHaveBeenCalledWith(database, owner, expect.any(Function));
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(identity);
  });

  it("serves only the original timed interval and attribution for a current cached label", async () => {
    const { repository, input, cache, enqueue, result, segment } = labelFixture();
    cache.mockResolvedValue(result);
    const alias = await repository.get(input);
    const section = alias.sections.find(({ kind }) => kind === "named-trail");
    expect(alias.nameStatus).toBe("ready");
    expect(section).toEqual({
      kind: "named-trail",
      sectionId: expect.any(String),
      name: segment.name,
      attribution: segment.attribution,
      suggestedGhost: null,
      anchor: {
        start: {
          lat: segment.start.lat,
          lng: segment.start.lng,
          timestampMs: segment.start.timestampMs,
          distanceMeters: 20,
        },
        end: {
          lat: segment.end.lat,
          lng: segment.end.lng,
          timestampMs: segment.end.timestampMs,
          distanceMeters: 300,
        },
        elapsedMs: 40_000,
      },
    });
    await expect(repository.get({ activityId: anchorId })).resolves.toEqual(alias);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("reserves eight named rows after the canonical route when GPS stretches fill the section limit", async () => {
    const stretches = Array.from({ length: 63 }, (_, index) =>
      match({
        kind: "shared-stretch",
        sectionId: `stretch-${index}`,
        passId: `stretch-pass-${index}`,
        activityId: activityId(100 + index),
      }),
    );
    const { repository, reads } = fixture([match(), ...stretches]);
    const input = { activityId: aliasId };
    const base = await repository.get(input);
    expect(base.sections).toHaveLength(64);
    const names = Array.from({ length: 10 }, (_, index) => {
      const { start, end } = interval(anchorStart + index * 2_000, 1_000);
      return {
        kind: "named-trail" as const,
        name: `Trail ${index}`,
        attribution: "© OpenStreetMap contributors · Powered by Geoapify",
        start: { ...start, originalIndex: index * 2 },
        end: { ...end, originalIndex: index * 2 + 1 },
      };
    });
    reads.readLabels.mockResolvedValue({ status: "ready", sections: names });

    const detail = await repository.get(input);
    expect(detail.nameStatus).toBe("ready");
    expect(detail.historyCoverage).toBe(base.historyCoverage);
    expect(detail.sections).toHaveLength(64);
    expect(detail.sections[0]).toEqual(base.sections[0]);
    expect(detail.sections.slice(1, 9)).toMatchObject(
      names.slice(0, 8).map(({ name }) => ({ kind: "named-trail", name, suggestedGhost: null })),
    );
    expect(detail.sections.slice(9)).toEqual(base.sections.slice(1, 56));
  });

  it.each(["withdrawn", "reenabled", "inactive", "replaced"])(
    "drops cached names when the source or consent is %s during the read",
    async (change) => {
      const { repository, input, cache, enqueue, consent, state, result } = labelFixture();
      cache.mockImplementation(async () => {
        if (change === "withdrawn") consent.mockResolvedValue(null);
        if (change === "reenabled")
          consent.mockResolvedValue({ revision: "2026-11-25T10:00:00.000002Z" });
        if (change === "inactive") state.activeAnchor = false;
        if (change === "replaced") state.markerSignature = "changed";
        return result;
      });
      const details = await repository.get(input);
      expect(details).toMatchObject({
        availability: "ready",
        sections: [{ kind: "route", anchor: wholeRoute }],
      });
      expect(details.nameStatus).not.toBe("ready");
      expect(details.sections.some(({ kind }) => kind.startsWith("named-"))).toBe(false);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it("skips cache and enqueue when disabled or an account has no consent", async () => {
    const { repository, input, cache, enqueue, consent } = labelFixture();
    vi.stubEnv("GHOST_MAP_LABELS_REGION", "disabled");
    await expect(repository.get(input)).resolves.toMatchObject({ nameStatus: "disabled" });
    expect(consent).not.toHaveBeenCalled();
    vi.stubEnv("GHOST_MAP_LABELS_REGION", "eu");
    consent.mockResolvedValue(null);
    await expect(repository.get(input)).resolves.toMatchObject({ nameStatus: "disabled" });
    expect(cache).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("uses cached terminal statuses and preserves base timing on enqueue errors", async () => {
    const { repository, input, cache, enqueue, result } = labelFixture();
    cache.mockResolvedValueOnce({ ...result, status: "unavailable", sections: [] });
    await expect(repository.get(input)).resolves.toMatchObject({
      availability: "ready",
      nameStatus: "unavailable",
    });
    cache.mockResolvedValueOnce({ status: "error", reason: "rate-limited" });
    await expect(repository.get(input)).resolves.toMatchObject({
      availability: "ready",
      nameStatus: "error",
    });
    expect(enqueue).not.toHaveBeenCalled();
    const failure = new Error("queue unavailable");
    enqueue.mockRejectedValueOnce(failure);
    await expect(repository.get(input)).resolves.toMatchObject({
      availability: "ready",
      nameStatus: "error",
      sections: [{ kind: "route", anchor: wholeRoute }],
    });
    expect(captureException).toHaveBeenCalledWith(failure, expect.anything());
  });

  it("keeps pass cursors valid through a scalar-only page replacement", async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY_BASE64", Buffer.alloc(32, 4).toString("base64"));
    const { repository, state, scope, candidateId } = publicationFixture();
    const first = await repository.passes(scope);
    expect(first.passes).toHaveLength(20);
    expect(first.nextCursor).toEqual(expect.any(String));
    const next = { ...scope, cursor: first.nextCursor ?? "missing" };
    state.version = "8";
    state.digest = "scalar-only";
    await expect(repository.passes(next)).resolves.toMatchObject({
      passes: [{ passId: "pass-20" }, { passId: "pass-21" }],
      nextCursor: null,
    });

    state.frontier = "continued";
    await expect(repository.passes(next)).rejects.toMatchObject({ code: "NOT_FOUND" });
    state.frontier = null;
    state.historyGeneration = "replaced-history";
    await expect(repository.passes(next)).rejects.toMatchObject({ code: "NOT_FOUND" });
    state.historyGeneration = "history";
    state.staleTrack = candidateId;
    await expect(repository.passes(next)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("compares the same pass through an accepted scalar-only replacement during replay loading", async () => {
    const { repository, state, scope, comparison } = publicationFixture();
    const input = { ...scope, passId: "pass-00" };
    state.beforeReplay = () => {
      state.version = "8";
      state.digest = "scalar-only";
    };
    await expect(repository.compare(input)).resolves.toEqual(comparison);
    state.scalarCurrent = false;
    await expect(repository.compare(input)).resolves.toEqual({
      ...comparison,
      metrics: { ...comparison.metrics, heartRateBpm: null },
    });
    state.beforeReplay = () => {
      state.frontier = "continued";
    };
    await expect(repository.compare(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("requires active selected recordings even when the canonical groups remain visible", async () => {
    const prior = match();
    const { repository, reads, activeMembers } = fixture([prior]);
    const initial = await repository.get({ activityId: anchorId });
    const sectionId = initial.sections[0]?.sectionId ?? "missing";
    const scope = { activityId: anchorId, sectionId };
    activeMembers.delete(prior.source.memberActivityId);

    await expect(repository.get({ activityId: anchorId })).resolves.toMatchObject({
      historyCoverage: "partial",
      sections: [{ firstVisit: false, suggestedGhost: null }],
    });
    await expect(repository.passes(scope)).resolves.toEqual({ passes: [], nextCursor: null });
    await expect(repository.compare({ ...scope, passId: prior.passId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(reads.readComparison).not.toHaveBeenCalled();

    for (const source of [
      { ...prior.source, activityId: activityId(80) },
      { ...prior.source, providerId: "changed-provider" },
    ]) {
      activeMembers.set(prior.source.memberActivityId, source);
      await expect(repository.passes(scope)).resolves.toEqual({ passes: [], nextCursor: null });
    }

    activeMembers.delete(aliasId);
    await expect(repository.get({ activityId: aliasId })).resolves.toMatchObject({
      availability: "processing",
      sections: [],
    });
  });

  it("keeps one canonical route with projected pass IDs across differently timed anchor boundaries", async () => {
    const stretchOne = match({
      kind: "shared-stretch",
      sectionId: "stretch-one",
      passId: "pass-one",
      anchor: interval(anchorStart, 15_000),
    });
    const stretchTwo = match({
      kind: "shared-stretch",
      sectionId: "stretch-two",
      passId: "pass-two",
      anchor: interval(anchorStart + 20_000, 15_000),
    });
    const newerShift = match({
      sectionId: "projected-shifted-route",
      passId: "newer-shifted",
      activityId: activityId(11),
      passStartedAtMs: oldStart + 100_000,
      passEndedAtMs: oldStart + 155_000,
      elapsedMs: 55_000,
      anchor: shiftedRoute,
    });
    const { repository, reads, activity } = fixture([newerShift, stretchOne, match(), stretchTwo]);

    const result = await repository.get({ activityId: aliasId });
    expect(activity.findSensorWindow).toHaveBeenCalledWith(aliasId);
    expect(reads.readAnchor).toHaveBeenCalledWith(
      expect.objectContaining({ activityId: anchorId }),
      true,
    );
    expect(result).toMatchObject({
      availability: "ready",
      sport: "running",
      nameStatus: "disabled",
      historyCoverage: "complete",
    });
    expect(result.sections).toEqual([
      expect.objectContaining({
        kind: "route",
        anchor: wholeRoute,
        geometry,
        suggestedGhost: { passId: "previous-best", reason: "previous-best" },
      }),
      expect.objectContaining({
        kind: "shared-stretch",
        sectionId: "stretch-one",
        anchor: stretchOne.anchor,
      }),
      expect.objectContaining({
        kind: "shared-stretch",
        sectionId: "stretch-two",
        anchor: stretchTwo.anchor,
      }),
    ]);
    const routeId = result.sections[0]?.sectionId ?? "missing";
    expect((await repository.get({ activityId: anchorId })).sections[0]?.sectionId).toBe(routeId);
    await expect(repository.passes({ activityId: anchorId, sectionId: routeId })).resolves.toEqual({
      passes: [
        {
          passId: "newer-shifted",
          activityId: activityId(11),
          elapsedMs: 55_000,
          startedAt: originalWorkoutStart,
        },
        {
          passId: "previous-best",
          activityId: activityId(10),
          elapsedMs: 65_000,
          startedAt: originalWorkoutStart,
        },
      ],
      nextCursor: null,
    });
    await expect(
      repository.passes({ activityId: anchorId, sectionId: stretchOne.sectionId }),
    ).resolves.toMatchObject({ passes: [{ passId: "pass-one" }] });
  });

  it("offers newest visible traversals under incomplete history and rejects later or overlapping traversals", async () => {
    const hiddenId = activityId(12);
    const newer = match({
      passId: "newer",
      activityId: anchorId,
      passStartedAtMs: anchorStart - 90_000,
      passEndedAtMs: anchorStart - 10_000,
      elapsedMs: 80_000,
    });
    const { repository, activity } = fixture(
      [
        match(),
        newer,
        match({
          passId: "hidden",
          activityId: hiddenId,
          passStartedAtMs: anchorStart - 80_000,
          passEndedAtMs: anchorStart - 15_000,
        }),
        match({
          passId: "overlapping",
          activityId: anchorId,
          passStartedAtMs: anchorStart - 20_000,
          passEndedAtMs: anchorStart + 45_000,
        }),
        match({
          passId: "future",
          activityId: activityId(13),
          passStartedAtMs: anchorStart + 1_000,
          passEndedAtMs: anchorStart + 66_000,
        }),
      ],
      { hidden: new Set([hiddenId]) },
    );

    const result = await repository.get({ activityId: anchorId });
    expect(result.historyCoverage).toBe("partial");
    expect(result.sections[0]?.suggestedGhost).toEqual({ passId: "newer", reason: "most-recent" });
    expect(activity.resolveVisibleActivityIds).toHaveBeenCalledWith(
      expect.arrayContaining([anchorId, activityId(10), hiddenId]),
    );
    await expect(
      repository.passes({
        activityId: anchorId,
        sectionId: result.sections[0]?.sectionId ?? "missing",
      }),
    ).resolves.toMatchObject({
      passes: [{ passId: "newer" }, { passId: "previous-best" }],
    });
  });

  it("verifies first visits only after complete currently visible history, with geometry even while history is partial", async () => {
    const hiddenNonMatch = activityId(30);
    const complete = fixture();
    const restricted = fixture([], { accessWindow: limitedWindow });
    const hidden = fixture([], {
      checkedActivityIds: [hiddenNonMatch],
      hidden: new Set([hiddenNonMatch]),
    });
    const incomplete = fixture([], { historyCoverage: "partial" });

    await expect(complete.repository.get({ activityId: aliasId })).resolves.toMatchObject({
      historyCoverage: "complete",
      sections: [{ anchor: wholeRoute, geometry, firstVisit: true, suggestedGhost: null }],
    });
    for (const { repository } of [restricted, hidden, incomplete]) {
      await expect(repository.get({ activityId: aliasId })).resolves.toMatchObject({
        availability: "ready",
        historyCoverage: "partial",
        sections: [{ anchor: wholeRoute, geometry, firstVisit: false, suggestedGhost: null }],
      });
    }
    expect(restricted.reads.readAnchor).toHaveBeenCalledWith(expect.anything(), false);
    const processing = fixture();
    processing.reads.readAnchor.mockResolvedValue({ status: "processing" });
    await expect(processing.repository.get({ activityId: aliasId })).resolves.toMatchObject({
      availability: "processing",
      sections: [],
    });
    const unavailable = fixture();
    unavailable.reads.readAnchor.mockResolvedValue({ status: "unavailable" });
    await expect(unavailable.repository.get({ activityId: aliasId })).resolves.toMatchObject({
      availability: "unavailable",
      sections: [],
    });
  });

  it("uses a scoped bounded keyset across same-date ties and current visibility changes", async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY_BASE64", Buffer.alloc(32, 4).toString("base64"));
    const passes = Array.from({ length: 24 }, (_, index) =>
      match({
        passId: `tie-${String(index).padStart(2, "0")}`,
        activityId: activityId(10 + Math.floor(index / 2)),
      }),
    );
    const { repository, hidden } = fixture([...passes].reverse());
    const result = await repository.get({ activityId: aliasId });
    const sectionId = result.sections[0]?.sectionId ?? "missing";
    const first = await repository.passes({ activityId: aliasId, sectionId });
    expect(first.passes.map(({ passId }) => passId)).toEqual(
      passes.slice(0, 20).map(({ passId }) => passId),
    );
    const cursor = first.nextCursor ?? "missing";
    expect(cursor.length).toBeLessThanOrEqual(2_048);
    expect(cursor).not.toContain("tie-19");

    hidden.add(activityId(20));
    await expect(repository.passes({ activityId: anchorId, sectionId, cursor })).resolves.toEqual({
      passes: ["tie-22", "tie-23"].map((passId) => ({
        passId,
        activityId: activityId(21),
        elapsedMs: 65_000,
        startedAt: originalWorkoutStart,
      })),
      nextCursor: null,
    });
    for (const options of [
      { ownerId: activityId(75) },
      { generation: "replaced" },
      { accessWindow: limitedWindow },
    ]) {
      await expect(
        fixture(passes, options).repository.passes({ activityId: anchorId, sectionId, cursor }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("treats a wrong-owner anchor, hidden pass, wrong section, and stale comparison as unavailable", async () => {
    const prior = match({ passId: "physical-pass", sectionId: "physical-section" });
    const { repository, reads, hidden, activeMembers } = fixture([prior]);
    const wrongOwner = activityId(40);
    await expect(repository.get({ activityId: wrongOwner })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(reads.readAnchor).not.toHaveBeenCalled();
    const result = await repository.get({ activityId: aliasId });
    const sectionId = result.sections[0]?.sectionId ?? "missing";

    await expect(
      repository.compare({
        activityId: anchorId,
        sectionId: "physical-section",
        passId: prior.passId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    hidden.add(prior.activityId);
    await expect(
      repository.compare({ activityId: anchorId, sectionId, passId: prior.passId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(reads.readComparison).not.toHaveBeenCalled();

    hidden.delete(prior.activityId);
    reads.readComparison.mockResolvedValueOnce(null);
    await expect(
      repository.compare({ activityId: aliasId, sectionId, passId: prior.passId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(reads.readComparison).toHaveBeenCalledWith(
      expect.objectContaining({ activityId: anchorId }),
      expect.objectContaining({ sectionId: "physical-section", passId: "physical-pass" }),
    );

    const candidate = interval(oldStart, prior.elapsedMs);
    const comparison: GhostSessionsCompareResponse = {
      anchor: wholeRoute,
      candidate,
      elapsedDifferenceMs: -5_000,
      timeBasis: "elapsed-including-recorded-stops",
      replay: [
        { anchor: wholeRoute.start, candidate: candidate.start },
        { anchor: wholeRoute.end, candidate: candidate.end },
      ],
      replayDownsampled: false,
      metrics: {
        paceSecondsPerKm: { anchor: 120, candidate: 130 },
        heartRateBpm: null,
        powerWatts: null,
      },
    };
    reads.readComparison.mockResolvedValueOnce(comparison);
    await expect(
      repository.compare({ activityId: aliasId, sectionId, passId: prior.passId }),
    ).resolves.toEqual(comparison);

    reads.readComparison.mockImplementationOnce(async () => {
      activeMembers.delete(prior.source.memberActivityId);
      return comparison;
    });
    await expect(
      repository.compare({ activityId: aliasId, sectionId, passId: prior.passId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
