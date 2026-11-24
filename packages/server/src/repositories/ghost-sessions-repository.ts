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
import { readGhostMapLabelsRegion } from "dofek/analytics/ghost-route-label-config";
import type { Database } from "dofek/db";
import {
  AccountErasureUserFencedError,
  withAccountErasureUserWriteFence,
} from "dofek/db/account-erasure";
import {
  ghostScalarProofProviders,
  ghostScalarProofSql,
  ghostScalarProofWindowColumns,
  ghostScalarProofWindowRow,
} from "dofek/db/activity-ghost-scalar-sample";
import { readGhostMapLabelConsent } from "dofek/db/ghost-map-label-consent";
import {
  ghostRouteLabelsSourceVersion,
  hasActiveGhostMember as hasActiveMember,
  readGhostTrackEvidence,
  resolveActiveGhostMembers,
  type SelectedGhostMember as SelectedMember,
  type GhostTrackEvidence as TrackEvidence,
  ghostTrackStampSchema as trackStampSchema,
} from "dofek/db/ghost-track-evidence";
import { enqueueGhostRouteLabels } from "dofek/jobs/queues";
import { queryCache } from "dofek/lib/cache";
import { captureException } from "dofek/lib/error-reporting";
import {
  type GhostRouteLabelsCacheResult,
  readGhostRouteLabelsCache,
} from "dofek/lib/ghost-route-labels-cache";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { ActivityRepository } from "./activity-repository.ts";
import { activitySearchCursor } from "./activity-search-pagination.ts";
import type { ActivitySensorQueryStore, ActivitySensorWindow } from "./activity-sensor-types.ts";

type Interval = GhostSessionsCompareResponse["anchor"];
type Section = GhostSessionsGetResponse["sections"][number];
type Pass = GhostSessionsPassesResponse["passes"][number];
type ReadyTrack = Extract<TrackEvidence, { status: "ready" }>;
type CachedNamedSections = Extract<
  GhostRouteLabelsCacheResult,
  { status: "ready" | "unavailable" }
>["sections"];
type RouteLabels =
  | { status: "ready"; sections: CachedNamedSections }
  | { status: "disabled" | "processing" | "unavailable" | "error" };
type LabelDatabase = Pick<Database, "execute" | "transaction">;

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

interface GhostSessionReads {
  readAnchor(window: ActivitySensorWindow, checkCompleteHistory: boolean): Promise<SavedAnchor>;
  readLabels(window: ActivitySensorWindow, source: ReadyTrack): Promise<RouteLabels>;
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
const namedSectionLimit = 8;
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

const sectionSchema = ghostSessionsGetResponseSchema.shape.sections.element;

function namedSections(activityId: string, sections: CachedNamedSections) {
  return sections.flatMap(({ kind, name, attribution, start: from, end: through }) => {
    const { originalIndex: startIndex, ...start } = from;
    const { originalIndex: endIndex, ...end } = through;
    if (startIndex >= endIndex) return [];
    const id = createHash("sha256")
      .update(
        JSON.stringify([
          activityId,
          kind,
          start.timestampMs,
          end.timestampMs,
          startIndex,
          endIndex,
        ]),
      )
      .digest("hex");
    const named = sectionSchema.safeParse({
      kind,
      name,
      attribution,
      sectionId: `named:${id}`,
      suggestedGhost: null,
      anchor: { start, end, elapsedMs: end.timestampMs - start.timestampMs },
    });
    return named.success ? [named.data] : [];
  });
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
    const labels: RouteLabels =
      saved.gpsCoverage === "unusable"
        ? { status: "disabled" }
        : await this.#dependencies.reads.readLabels(window, saved.source);
    const named =
      labels.status === "ready"
        ? namedSections(window.activityId, labels.sections).slice(0, namedSectionLimit)
        : [];
    const routeId = routeSectionId(window.activityId);
    const route = sections.get(routeId);
    sections.delete(routeId);
    const leadingSections = route
      ? [summarizeSection(routeId, route, historyCoverage), ...named]
      : named;
    const stretches = [...sections]
      .slice(0, sectionLimit - leadingSections.length)
      .map(([sectionId, section]) => summarizeSection(sectionId, section, historyCoverage));
    return {
      availability: "ready",
      sport: saved.sport,
      gpsCoverage: saved.gpsCoverage,
      historyCoverage,
      nameStatus: labels.status === "ready" && named.length === 0 ? "unavailable" : labels.status,
      sections: [...leadingSections, ...stretches],
    };
  }

  async passes({
    activityId,
    sectionId,
    cursor,
  }: z.infer<typeof ghostSessionsPassesInputSchema>): Promise<GhostSessionsPassesResponse> {
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

const analyticsSettings = `SETTINGS join_use_nulls = 1, max_threads = 1,
  enable_materialized_cte = 1, log_queries = 0`;
const liveOwner = `lower(hex(SHA256(toString({userId:UUID})))) NOT IN (
  SELECT user_hash FROM ingest.account_erasure_fence FINAL
)`;
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

function readTrackEvidence(
  store: ActivitySensorQueryStore,
  window: ActivitySensorWindow,
  candidateIds: readonly string[],
) {
  return readGhostTrackEvidence(store.query.bind(store), {
    userId: window.userId,
    activityIds: [window.activityId, ...candidateIds],
  });
}

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

const savedScalarProofSchema = z.object({
  activityId: z.uuid(),
  memberActivityId: z.uuid(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  count: z.number().int().min(1).max(4_000),
  digest: z.string(),
});
const proofRowSchema = z.object({
  windowId: z.number(),
  count: z.coerce.number(),
  digest: z.string(),
});

async function verifiesScalars(
  store: ActivitySensorQueryStore,
  window: ActivitySensorWindow,
  match: SavedMatch,
  proof: string,
): Promise<boolean> {
  const parsed = z
    .tuple([savedScalarProofSchema, savedScalarProofSchema])
    .safeParse(JSON.parse(proof));
  if (!parsed.success) return false;
  const [anchor, candidate] = parsed.data;
  if (anchor.activityId !== window.activityId || candidate.activityId !== match.activityId)
    return false;
  const rows = await store.query(
    proofRowSchema,
    `
    WITH measured_windows AS MATERIALIZED (
      SELECT * FROM format('JSONEachRow', {windowColumns:String}, {windows:String})
    ), ${ghostScalarProofSql("measured_windows")}
    SELECT window_id AS windowId, raw_count AS count, digest FROM ghost_scalar_proofs
    WHERE ${liveOwner}
    ${analyticsSettings}, date_time_input_format = 'best_effort'`,
    {
      ...ghostScalarProofProviders,
      userId: window.userId,
      windowColumns: ghostScalarProofWindowColumns,
      windows: parsed.data
        .map((entry, index) => JSON.stringify(ghostScalarProofWindowRow(entry, index)))
        .join("\n"),
      ghostScalarFetchLimit: Math.max(anchor.count, candidate.count) + 1,
    },
  );
  return parsed.data.every((expected, index) =>
    rows.some(
      (row) =>
        row.windowId === index && row.count === expected.count && row.digest === expected.digest,
    ),
  );
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
  const comparison = ghostSessionsCompareResponseSchema.parse(JSON.parse(saved.comparison));
  const metricProof =
    comparison.metrics.heartRateBpm !== null || comparison.metrics.powerWatts !== null;
  const scalarsCurrent =
    !metricProof || (await verifiesScalars(store, window, match, saved.scalarProof));
  const current = await readTrackEvidence(store, window, [match.activityId]);
  const anchor = current.get(window.activityId);
  if (
    !sameStamp(anchor, match.anchorStamp) ||
    !hasAnchorMember(anchor, window) ||
    !sameStamp(current.get(match.activityId), match.candidateStamp)
  )
    return null;
  return scalarsCurrent
    ? comparison
    : {
        ...comparison,
        metrics: { ...comparison.metrics, heartRateBpm: null, powerWatts: null },
      };
}

async function readRouteLabels(
  db: LabelDatabase,
  store: ActivitySensorQueryStore,
  window: ActivitySensorWindow,
  source: ReadyTrack,
): Promise<RouteLabels> {
  try {
    if (!readGhostMapLabelsRegion(process.env.GHOST_MAP_LABELS_REGION))
      return { status: "disabled" };
    const consent = await readGhostMapLabelConsent(db, window.userId);
    if (!consent) return { status: "disabled" };
    const revision = {
      userId: window.userId,
      activityId: window.activityId,
      sourceVersion: ghostRouteLabelsSourceVersion(source),
      consentRevision: consent.revision,
    };
    const cached = await readGhostRouteLabelsCache(queryCache, revision);
    if (cached && cached.status !== "ready") return { status: cached.status };
    return await withAccountErasureUserWriteFence(
      db,
      window.userId,
      async (transaction): Promise<RouteLabels> => {
        const current = (await readTrackEvidence(store, window, [])).get(window.activityId);
        if (
          current?.status !== "ready" ||
          ghostRouteLabelsSourceVersion(current) !== revision.sourceVersion
        )
          return { status: "unavailable" };
        const active = await resolveActiveGhostMembers(transaction, window.userId, [
          current.memberActivityId,
        ]);
        const member = active.get(current.memberActivityId);
        if (
          !hasActiveMember(active, current) ||
          member?.sport !== current.sport ||
          member.modality !== current.modality
        )
          return { status: "disabled" };
        if (
          (await readGhostMapLabelConsent(transaction, window.userId))?.revision !==
          revision.consentRevision
        )
          return { status: "disabled" };
        if (cached) return { status: "ready", sections: cached.sections };
        await enqueueGhostRouteLabels(revision);
        return { status: "processing" };
      },
    );
  } catch (error: unknown) {
    if (error instanceof AccountErasureUserFencedError) return { status: "disabled" };
    captureException(error, { tags: { source: "ghost-route-labels-detail" } });
    return { status: "error" };
  }
}

export function createGhostSessionsRepository({
  db,
  userId,
  timezone,
  accessWindow,
  sensorStore,
}: {
  db: LabelDatabase;
  userId: string;
  timezone: string;
  accessWindow: AccessWindow;
  sensorStore: ActivitySensorQueryStore;
}): GhostSessionsRepository {
  return new GhostSessionsRepository({
    ownerId: userId,
    timezone,
    accessWindow,
    activity: new ActivityRepository(db, userId, timezone, accessWindow),
    resolveActiveMembers: (memberIds) => resolveActiveGhostMembers(db, userId, memberIds),
    reads: {
      readAnchor: (window, checkHistory) => readSavedAnchor(sensorStore, window, checkHistory),
      readLabels: (window, source) => readRouteLabels(db, sensorStore, window, source),
      readComparison: (window, match) => readSavedComparison(sensorStore, window, match),
    },
  });
}
