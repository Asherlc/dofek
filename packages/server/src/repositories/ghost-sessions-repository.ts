import { createHash } from "node:crypto";
import {
  type GhostSessionsCompareResponse,
  type GhostSessionsGetResponse,
  type GhostSessionsPassesResponse,
  type ghostSessionsCompareInputSchema,
  ghostSessionsCompareResponseSchema,
  type ghostSessionsGetInputSchema,
  ghostSessionsGetResponseSchema,
  type ghostSessionsPassesInputSchema,
  ghostSessionsPassesResponseSchema,
  selectGhostSessionDefault,
} from "@dofek/training/ghost-sessions";
import { TRPCError } from "@trpc/server";
import { readGhostHistoryEvidence } from "dofek/analytics/ghost-history-evidence";
import {
  hasActiveGhostMember as hasActiveMember,
  resolveActiveGhostMembers,
  type SelectedGhostMember as SelectedMember,
  type GhostTrackEvidence as TrackEvidence,
  ghostTrackStampSchema as trackStampSchema,
} from "dofek/db/ghost-track-evidence";
import { ghostSectionPreparationLimits } from "dofek/lib/ghost-route-section-results";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { ActivityRepository } from "./activity-repository.ts";
import { activitySearchCursor } from "./activity-search-pagination.ts";
import type { ActivitySensorQueryStore, ActivitySensorWindow } from "./activity-sensor-types.ts";
import {
  analyticsSettings,
  climbPrefix,
  createGhostPreparedReads,
  currentComparisonMetrics,
  isPreparedSectionId,
  liveOwner,
  type PreparedRequest,
  preparedSectionDetails,
  type ReadyTrack,
  readTrackEvidence,
  type ServingDatabase,
} from "./ghost-sessions-prepared.ts";

type Interval = GhostSessionsCompareResponse["anchor"];
type Section = GhostSessionsGetResponse["sections"][number];
type Pass = GhostSessionsPassesResponse["passes"][number];
interface SavedMatch extends Pass {
  kind: "full-route" | "shared-stretch";
  sectionId: string;
  anchor: Interval;
  passStartedAtMs: number;
  passEndedAtMs: number;
  page: {
    anchorGeneration: string;
    historyGeneration: string;
    frontier: string;
    requestCursor: string;
  };
  anchorStamp: string;
  candidateStamp: string;
  source: SelectedMember;
}

type SavedAnchor =
  | { status: "unavailable" | "processing" }
  | {
      status: "ready";
      sport: NonNullable<GhostSessionsGetResponse["sport"]>;
      gpsCoverage: NonNullable<GhostSessionsGetResponse["gpsCoverage"]>;
      anchor: Interval | null;
      geometry: Section["geometry"];
      source: ReadyTrack;
      generation: string;
      historyCoverage: GhostSessionsGetResponse["historyCoverage"];
      checkedActivityIds: readonly string[];
      matches: readonly SavedMatch[];
    };

interface GhostSessionReads extends ReturnType<typeof createGhostPreparedReads> {
  readAnchor(window: ActivitySensorWindow, checkCompleteHistory: boolean): Promise<SavedAnchor>;
  readComparison(
    window: ActivitySensorWindow,
    match: SavedMatch,
  ): Promise<GhostSessionsCompareResponse | null>;
}

interface Dependencies {
  ownerId: string;
  timezone: string;
  accessWindow: AccessWindow;
  activity: Pick<ActivityRepository, "findSensorWindow" | "resolveVisibleActivityIds">;
  resolveActiveMembers(memberIds: readonly string[]): Promise<ReadonlyMap<string, SelectedMember>>;
  reads: GhostSessionReads;
}

type ReadyAnchor = Extract<SavedAnchor, { status: "ready" }>;
type HistoryCoverage = GhostSessionsGetResponse["historyCoverage"];

interface SectionMatches {
  kind: "route" | "shared-stretch";
  anchor: Interval | null;
  geometry?: Section["geometry"];
  matches: SavedMatch[];
}

const pageSize = 20;
const sectionLimit = 64;
const cursorPositionSchema = z.strictObject({
  passStartedAtMs: z.number(),
  activityId: z.uuid(),
  passId: z.string().min(1).max(256),
});
type CursorPosition = z.infer<typeof cursorPositionSchema>;

function orderedId(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function comparePassPosition(left: CursorPosition, right: CursorPosition): number {
  return (
    right.passStartedAtMs - left.passStartedAtMs ||
    orderedId(left.activityId, right.activityId) ||
    orderedId(left.passId, right.passId)
  );
}

function unavailable(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: "Ghost session not found" });
}

function routeSectionId(activityId: string): string {
  return `route:${activityId}`;
}

function groupMatches(activityId: string, saved: ReadyAnchor, matches: SavedMatch[]) {
  const routeId = routeSectionId(activityId);
  const sections = new Map<string, SectionMatches>();
  if (saved.anchor || saved.geometry?.length || matches.some(({ kind }) => kind === "full-route")) {
    sections.set(routeId, {
      kind: "route",
      anchor: saved.anchor,
      geometry: saved.geometry?.length ? saved.geometry : undefined,
      matches: [],
    });
  }
  for (const match of matches) {
    const isRoute = match.kind === "full-route";
    const sectionId = isRoute ? routeId : match.sectionId;
    const existing = sections.get(sectionId);
    if (existing) {
      existing.matches.push(match);
    } else {
      sections.set(sectionId, {
        kind: "shared-stretch",
        anchor: match.anchor,
        matches: [match],
      });
    }
  }
  return sections;
}

function summarizeSection(
  sectionId: string,
  { kind, anchor, geometry, matches }: SectionMatches,
  historyCoverage: HistoryCoverage,
): Section {
  const latest = matches[0];
  const recommendation = anchor
    ? selectGhostSessionDefault({
        anchor: {
          startTimestampMs: anchor.start.timestampMs,
          endTimestampMs: anchor.end.timestampMs,
          elapsedMs: anchor.elapsedMs,
        },
        passes: matches.map((match) => ({
          ...match,
          anchor: {
            startTimestampMs: match.anchor.start.timestampMs,
            endTimestampMs: match.anchor.end.timestampMs,
          },
        })),
        historyCoverage,
      })
    : {
        firstVisit: false,
        suggestedGhost: latest ? { passId: latest.passId, reason: "most-recent" as const } : null,
      };
  return { kind, sectionId, anchor, ...(geometry && { geometry }), ...recommendation };
}

export class GhostSessionsRepository {
  readonly #dependencies: Dependencies;

  constructor(dependencies: Dependencies) {
    this.#dependencies = dependencies;
  }

  #activeMembers(sources: readonly SelectedMember[]) {
    const memberIds = [...new Set(sources.map(({ memberActivityId }) => memberActivityId))];
    return this.#dependencies.resolveActiveMembers(memberIds);
  }

  async #open(
    activityId: string,
    checkCompleteHistory: boolean,
  ): Promise<{
    window: ActivitySensorWindow;
    saved: SavedAnchor;
  }> {
    const window = await this.#dependencies.activity.findSensorWindow(activityId);
    if (!window || window.userId !== this.#dependencies.ownerId) throw unavailable();
    const saved = await this.#dependencies.reads.readAnchor(window, checkCompleteHistory);
    if (saved.status !== "ready") return { window, saved };
    const active = await this.#activeMembers([
      saved.source,
      ...saved.matches.map(({ source }) => source),
    ]);
    if (!hasActiveMember(active, saved.source)) return { window, saved: { status: "processing" } };
    const matches = saved.matches.filter(({ source }) => hasActiveMember(active, source));
    return {
      window,
      saved: {
        ...saved,
        matches,
        historyCoverage:
          matches.length === saved.matches.length ? saved.historyCoverage : "partial",
      },
    };
  }

  async #visibleSections(window: ActivitySensorWindow, saved: ReadyAnchor) {
    const canCoverHistory =
      this.#dependencies.accessWindow.kind === "full" &&
      saved.historyCoverage === "complete" &&
      saved.gpsCoverage !== "unusable";
    const eligibleIds = new Set(saved.matches.map(({ activityId }) => activityId));
    if (canCoverHistory) {
      for (const activityId of saved.checkedActivityIds) eligibleIds.add(activityId);
    }
    const visibleIds = await this.#dependencies.activity.resolveVisibleActivityIds([
      ...eligibleIds,
    ]);
    const matches = saved.matches
      .filter(
        (match) =>
          visibleIds.has(match.activityId) &&
          match.passStartedAtMs < match.passEndedAtMs &&
          match.passEndedAtMs <= match.anchor.start.timestampMs,
      )
      .sort(comparePassPosition);
    const historyCoverage =
      canCoverHistory &&
      visibleIds.size === eligibleIds.size &&
      matches.length === saved.matches.length
        ? "complete"
        : "partial";
    return { sections: groupMatches(window.activityId, saved, matches), historyCoverage } as const;
  }

  async #findSection(activityId: string, sectionId: string) {
    const { window, saved } = await this.#open(activityId, false);
    if (saved.status !== "ready") throw unavailable();
    const { sections } = await this.#visibleSections(window, saved);
    const section = sections.get(sectionId);
    if (!section) throw unavailable();
    return { window, saved, section };
  }

  async #findPreparedSection(activityId: string, request: PreparedRequest) {
    const { window, saved } = await this.#open(activityId, false);
    if (saved.status !== "ready" || saved.gpsCoverage === "unusable") throw unavailable();
    const reads = this.#dependencies.reads;
    if (request.sectionId.startsWith(climbPrefix)) {
      const [climb] = await reads.readClimbs(window, saved.source, request);
      if (!climb) throw unavailable();
      return climb;
    }
    const labels = await reads.readLabels(window, saved.source, request);
    const section = labels.status === "ready" ? labels.prepared?.[0] : undefined;
    if (!section) throw unavailable();
    return section;
  }

  async get({
    activityId,
  }: z.infer<typeof ghostSessionsGetInputSchema>): Promise<GhostSessionsGetResponse> {
    const { window, saved } = await this.#open(
      activityId,
      this.#dependencies.accessWindow.kind === "full",
    );
    if (saved.status !== "ready") {
      return {
        availability: saved.status,
        sport: null,
        gpsCoverage: null,
        historyCoverage: "partial",
        nameStatus: "disabled",
        sections: [],
      };
    }
    const { sections, historyCoverage } = await this.#visibleSections(window, saved);
    const labels =
      saved.gpsCoverage === "unusable"
        ? { status: "disabled" as const }
        : await this.#dependencies.reads.readLabels(window, saved.source);
    const named =
      labels.status === "ready"
        ? labels.sections.slice(0, ghostSectionPreparationLimits.sections)
        : [];
    const preparedClimbs =
      saved.gpsCoverage === "unusable"
        ? []
        : await this.#dependencies.reads.readClimbs(window, saved.source);
    const climbs = preparedClimbs.slice(0, ghostSectionPreparationLimits.sections).map(
      (climb): Section => ({
        kind: "unnamed-climb",
        sectionId: `${climbPrefix}${climb.sectionId}`,
        anchor: climb.anchor,
        ...preparedSectionDetails(climb),
      }),
    );
    const routeId = routeSectionId(window.activityId);
    const route = sections.get(routeId);
    sections.delete(routeId);
    const leadingSections = [
      ...(route ? [summarizeSection(routeId, route, historyCoverage)] : []),
      ...named,
      ...climbs,
    ];
    const stretches = [...sections]
      .slice(0, sectionLimit - leadingSections.length)
      .map(([sectionId, section]) => summarizeSection(sectionId, section, historyCoverage));
    return {
      availability: "ready",
      sport: saved.sport,
      gpsCoverage: saved.gpsCoverage,
      historyCoverage,
      nameStatus: labels.status === "ready" && named.length === 0 ? "unavailable" : labels.status,
      ...(named.length > 0 && labels.status === "ready" && labels.mapCoverage
        ? { mapCoverage: labels.mapCoverage }
        : {}),
      sections: [...leadingSections, ...stretches],
    };
  }

  async passes({
    activityId,
    sectionId,
    cursor,
  }: z.infer<typeof ghostSessionsPassesInputSchema>): Promise<GhostSessionsPassesResponse> {
    if (isPreparedSectionId(sectionId)) {
      if (cursor) throw unavailable();
      const section = await this.#findPreparedSection(activityId, { sectionId });
      return {
        passes: section.passes.map(({ passId, activityId, startedAt, comparison }) => ({
          passId,
          activityId,
          startedAt,
          elapsedMs: comparison.candidate.elapsedMs,
        })),
        nextCursor: null,
      };
    }
    const { window, saved, section } = await this.#findSection(activityId, sectionId);
    const codec = activitySearchCursor(cursorPositionSchema, [
      "ghost-sessions",
      window.userId,
      window.activityId,
      sectionId,
      saved.generation,
      this.#dependencies.timezone,
      this.#dependencies.accessWindow,
    ]);
    let after: CursorPosition | undefined;
    if (cursor) {
      try {
        after = await codec.decode(cursor);
      } catch (error) {
        if (error instanceof TRPCError && error.code === "BAD_REQUEST") throw unavailable();
        throw error;
      }
    }
    const remaining = after
      ? section.matches.filter((match) => comparePassPosition(match, after) > 0)
      : section.matches;
    const page = remaining.slice(0, pageSize);
    const last = page.at(-1);
    const nextCursor =
      remaining.length > pageSize && last
        ? await codec.encode({
            passStartedAtMs: last.passStartedAtMs,
            activityId: last.activityId,
            passId: last.passId,
          })
        : null;
    return {
      passes: page.map(({ passId, activityId, startedAt, elapsedMs }) => ({
        passId,
        activityId,
        startedAt,
        elapsedMs,
      })),
      nextCursor,
    };
  }

  async compare({
    activityId,
    sectionId,
    passId,
  }: z.infer<typeof ghostSessionsCompareInputSchema>): Promise<GhostSessionsCompareResponse> {
    if (isPreparedSectionId(sectionId)) {
      const section = await this.#findPreparedSection(activityId, { sectionId, passId });
      const pass = section.passes.find((candidate) => candidate.passId === passId);
      if (!pass) throw unavailable();
      return pass.comparison;
    }
    const { window, saved, section } = await this.#findSection(activityId, sectionId);
    const match = section.matches.find((candidate) => candidate.passId === passId);
    if (!match) throw unavailable();
    const comparison = await this.#dependencies.reads.readComparison(window, match);
    if (!comparison) throw unavailable();
    const active = await this.#activeMembers([saved.source, match.source]);
    if (!hasActiveMember(active, saved.source) || !hasActiveMember(active, match.source))
      throw unavailable();
    return comparison;
  }
}

const ownerAndAnchor = `user_id = {userId:UUID} AND activity_id = {activityId:UUID}`;
const historyTable = "analytics.ghost_session_history";
const pageTable = "analytics.ghost_session_page";
const pageGeneration = `anchor_generation = {anchorGeneration:String}
  AND history_generation = {historyGeneration:String}`;
const coverageSchema = ghostSessionsGetResponseSchema.shape.historyCoverage;
const anchorIntervalSchema = ghostSessionsCompareResponseSchema.shape.anchor;
const anchorSummarySchema = z.object({
  gpsCoverage: ghostSessionsGetResponseSchema.shape.gpsCoverage.unwrap(),
  anchor: anchorIntervalSchema.nullable(),
  geometry: z.union([
    z.tuple([]),
    ghostSessionsGetResponseSchema.shape.sections.element.options[0].shape.geometry.unwrap(),
  ]),
});
const coveragePageSchema = z.object({
  anchorGeneration: z.string().nullable(),
  historyGeneration: z.string().nullable(),
  nextCursor: z.string().nullable(),
  status: z.enum(["pending", "ready", "unavailable", "over-limit"]),
  sourceCoverage: coverageSchema,
  historyCoverage: coverageSchema,
  comparisonLimited: z.coerce.number(),
  version: z.string(),
});
const storedMatchSchema = z.tuple([
  z.string().min(1).max(256), // Projected section ID
  z.string().min(1).max(256), // Projected pass ID
  z.enum(["full-route", "shared-stretch"]),
  z.string(), // Anchor interval
  z.uuid(), // Candidate canonical ID
  z.iso.datetime(), // Candidate workout start
  z.number(), // Candidate traversal start
  z.number(), // Candidate traversal end
  ghostSessionsPassesResponseSchema.shape.passes.element.shape.elapsedMs,
  z.string(), // Source stamp
]);
const savedPageSchema = z.object({
  requestCursor: z.string(),
  nextCursor: z.string().nullable(),
  anchorStamp: z.string(),
  anchorSummary: z.string().nullable(),
  bounded: z.coerce.number(),
  matches: z.array(storedMatchSchema).max(32),
});
type SavedPage = z.infer<typeof savedPageSchema>;
// History evidence checks up to 256 prior groups and the worker admits 25 per page.
const publishedPageLimit = 11;

function sameStamp(
  current: TrackEvidence | undefined,
  saved: string,
): current is Extract<TrackEvidence, { status: "ready" }> {
  return current?.status === "ready" && JSON.stringify(trackStampSchema.parse(current)) === saved;
}

function hasAnchorMember(
  current: TrackEvidence | undefined,
  window: ActivitySensorWindow,
): boolean {
  return current?.status === "ready" && window.memberActivityIds.includes(current.memberActivityId);
}

function readPublishedPrefix(rows: SavedPage[], frontier: string | null) {
  const pages: SavedPage[] = [];
  const byCursor = new Map(rows.map((row) => [row.requestCursor, row]));
  let requestCursor: string | null = "";
  while (
    pages.length < publishedPageLimit &&
    requestCursor !== null &&
    requestCursor !== frontier
  ) {
    const page = byCursor.get(requestCursor);
    if (!page) break;
    const first = pages[0];
    if (first && first.anchorStamp !== page.anchorStamp) break;
    pages.push(page);
    byCursor.delete(requestCursor);
    requestCursor = page.nextCursor;
  }
  return {
    pages,
    finished: requestCursor === null && frontier === null && rows.length <= publishedPageLimit,
  };
}

async function readSavedAnchor(
  store: ActivitySensorQueryStore,
  window: ActivitySensorWindow,
  checkCompleteHistory: boolean,
): Promise<SavedAnchor> {
  const key = { userId: window.userId, activityId: window.activityId };
  const [state] = await store.query(
    coveragePageSchema,
    `
    SELECT anchor_generation AS anchorGeneration, history_generation AS historyGeneration,
      next_cursor AS nextCursor, anchor_status AS status, source_history_coverage AS sourceCoverage,
      history_coverage AS historyCoverage, comparison_limited AS comparisonLimited,
      toString(refresh_version) AS version
    FROM ${historyTable} FINAL WHERE ${ownerAndAnchor} AND ${liveOwner}
    ${analyticsSettings}`,
    key,
  );
  const scope =
    state?.status === "ready" && state.anchorGeneration && state.historyGeneration
      ? {
          anchorGeneration: state.anchorGeneration,
          historyGeneration: state.historyGeneration,
          frontier: state.nextCursor ?? "",
        }
      : null;
  // Fetch the compact tuple fields independently of comparison and scalar proof.
  const rows =
    scope && state
      ? await store.query(
          savedPageSchema,
          `
    SELECT request_cursor AS requestCursor, next_cursor AS nextCursor, anchor_stamp AS anchorStamp,
      anchor_summary AS anchorSummary, bounded,
      arrayZip(matches.section_id, matches.pass_id, matches.match_kind, matches.anchor_interval,
        matches.candidate_activity_id,
        arrayMap(started -> formatDateTime(started, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC'),
          matches.candidate_started_at),
        matches.candidate_pass_started_at_ms, matches.candidate_pass_ended_at_ms,
        matches.candidate_elapsed_ms, matches.candidate_stamp) AS matches
    FROM ${pageTable} FINAL
    WHERE ${ownerAndAnchor} AND ${pageGeneration} AND refresh_version <= {pointerVersion:UInt64}
      AND ${liveOwner}
    ORDER BY request_cursor LIMIT ${publishedPageLimit + 1}
    ${analyticsSettings}`,
          { ...key, ...scope, pointerVersion: state.version },
        )
      : [];
  const { pages, finished } = readPublishedPrefix(rows, state?.nextCursor ?? null);
  const first = pages[0];
  const current = await readTrackEvidence(
    store,
    window,
    pages.flatMap(({ matches }) => matches.map((match) => match[4])),
  );
  const anchor = current.get(window.activityId);
  if (!anchor || anchor.status === "unavailable") return { status: "unavailable" };
  if (
    !scope ||
    anchor.status !== "ready" ||
    !first?.anchorSummary ||
    !sameStamp(anchor, first.anchorStamp) ||
    !hasAnchorMember(anchor, window)
  )
    return { status: "processing" };

  const summary = anchorSummarySchema.parse(JSON.parse(first.anchorSummary));
  const matches: SavedMatch[] = [];
  let staleMatch = false;
  for (const page of pages) {
    for (const [
      sectionId,
      passId,
      kind,
      anchorInterval,
      activityId,
      startedAt,
      passStartedAtMs,
      passEndedAtMs,
      elapsedMs,
      candidateStamp,
    ] of page.matches) {
      const candidate = current.get(activityId);
      if (!sameStamp(candidate, candidateStamp)) {
        staleMatch = true;
        continue;
      }
      matches.push({
        sectionId,
        passId,
        kind,
        activityId,
        startedAt,
        passStartedAtMs,
        passEndedAtMs,
        elapsedMs,
        anchor: anchorIntervalSchema.parse(JSON.parse(anchorInterval)),
        page: {
          ...scope,
          requestCursor: page.requestCursor,
        },
        anchorStamp: first.anchorStamp,
        candidateStamp,
        source: candidate,
      });
    }
  }
  const history =
    checkCompleteHistory &&
    finished &&
    !staleMatch &&
    state?.historyCoverage === "complete" &&
    state.sourceCoverage === "complete" &&
    !state.comparisonLimited &&
    pages.every(({ bounded }) => !bounded)
      ? await readGhostHistoryEvidence(store.query.bind(store), key)
      : null;
  if (history && history.anchorStatus !== "ready") {
    return { status: history.anchorStatus === "pending" ? "processing" : "unavailable" };
  }
  const complete =
    history?.historyCoverage === "complete" &&
    history.historyGeneration === scope.historyGeneration;
  // Page versions and payload digests also change when only scalar measurements are refreshed.
  const generation = createHash("sha256")
    .update(JSON.stringify([scope, pages, matches.map(({ passId }) => passId)]))
    .digest("hex");
  return {
    ...summary,
    status: "ready",
    sport: anchor.sport,
    source: anchor,
    generation,
    historyCoverage: complete ? "complete" : "partial",
    checkedActivityIds: complete ? history.checkedActivityIds : [],
    matches,
  };
}

const savedComparisonSchema = z.object({ comparison: z.string(), scalarProof: z.string() });

async function readSavedComparison(
  store: ActivitySensorQueryStore,
  window: ActivitySensorWindow,
  match: SavedMatch,
): Promise<GhostSessionsCompareResponse | null> {
  const [saved] = await store.query(
    savedComparisonSchema,
    `
    WITH accepted_progress AS (
      SELECT refresh_version AS acceptedVersion
      FROM ${historyTable} FINAL
      WHERE ${ownerAndAnchor} AND ${pageGeneration} AND anchor_status = 'ready'
        AND coalesce(next_cursor, '') = {frontier:String} AND ${liveOwner}
    ), indexOf(arrayZip(matches.section_id, matches.pass_id),
      tuple({sectionId:String}, {passId:String})) AS selected
    SELECT arrayElement(matches.comparison, selected) AS comparison,
      arrayElement(matches.scalar_proof, selected) AS scalarProof
    FROM ${pageTable} FINAL CROSS JOIN accepted_progress
    WHERE ${ownerAndAnchor} AND ${pageGeneration} AND request_cursor = {requestCursor:String}
      AND refresh_version <= acceptedVersion AND anchor_stamp = {anchorStamp:String} AND selected > 0
      AND arrayElement(matches.candidate_stamp, selected) = {candidateStamp:String}
      AND arrayElement(matches.candidate_activity_id, selected) = {candidateActivityId:UUID}
    ${analyticsSettings}`,
    {
      userId: window.userId,
      activityId: window.activityId,
      ...match.page,
      sectionId: match.sectionId,
      passId: match.passId,
      anchorStamp: match.anchorStamp,
      candidateStamp: match.candidateStamp,
      candidateActivityId: match.activityId,
    },
  );
  if (!saved) return null;
  const comparison = await currentComparisonMetrics(
    store,
    window,
    match.activityId,
    ghostSessionsCompareResponseSchema.parse(JSON.parse(saved.comparison)),
    saved.scalarProof,
  );
  const current = await readTrackEvidence(store, window, [match.activityId]);
  const anchor = current.get(window.activityId);
  if (
    !sameStamp(anchor, match.anchorStamp) ||
    !hasAnchorMember(anchor, window) ||
    !sameStamp(current.get(match.activityId), match.candidateStamp)
  )
    return null;
  return comparison;
}

export function createGhostSessionsRepository({
  db,
  userId,
  timezone,
  accessWindow,
  sensorStore,
}: {
  db: ServingDatabase;
  userId: string;
  timezone: string;
  accessWindow: AccessWindow;
  sensorStore: ActivitySensorQueryStore;
}): GhostSessionsRepository {
  const activity = new ActivityRepository(db, userId, timezone, accessWindow);
  return new GhostSessionsRepository({
    ownerId: userId,
    timezone,
    accessWindow,
    activity,
    resolveActiveMembers: (memberIds) => resolveActiveGhostMembers(db, userId, memberIds),
    reads: {
      readAnchor: (window, checkHistory) => readSavedAnchor(sensorStore, window, checkHistory),
      ...createGhostPreparedReads(db, sensorStore, { timezone, accessWindow }),
      readComparison: (window, match) => readSavedComparison(sensorStore, window, match),
    },
  });
}
