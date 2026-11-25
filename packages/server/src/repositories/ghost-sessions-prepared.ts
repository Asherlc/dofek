import { createHash } from "node:crypto";
import {
  type GhostSessionsCompareResponse,
  type GhostSessionsGetResponse,
  ghostSessionsGetResponseSchema,
} from "@dofek/training/ghost-sessions";
import { readGhostMapLabelsRegion } from "dofek/analytics/ghost-route-label-config";
import type { Database, TransactionDatabase } from "dofek/db";
import {
  AccountErasureUserFencedError,
  withAccountErasureUserWriteFence,
} from "dofek/db/account-erasure";
import {
  ghostScalarProofProviders,
  ghostScalarProofSql,
  ghostScalarProofWindowColumns,
  ghostScalarProofWindowRow,
  readGhostAltitudeWindowProof,
} from "dofek/db/activity-ghost-scalar-sample";
import { readGhostMapLabelConsent } from "dofek/db/ghost-map-label-consent";
import {
  ghostRouteLabelsSourceVersion,
  hasActiveGhostMember as hasActiveMember,
  readGhostTrackEvidence,
  resolveActiveGhostMembers,
  type GhostTrackEvidence as TrackEvidence,
} from "dofek/db/ghost-track-evidence";
import { enqueueGhostRouteClimbs, enqueueGhostRouteLabels } from "dofek/jobs/queues";
import { queryCache } from "dofek/lib/cache";
import { captureException } from "dofek/lib/error-reporting";
import { readGhostRouteClimbsCache } from "dofek/lib/ghost-route-climbs-cache";
import {
  type GhostRouteLabelsCacheResult,
  readGhostRouteLabelsCache,
} from "dofek/lib/ghost-route-labels-cache";
import {
  ghostRecordedSectionId,
  ghostSectionPreparationLimits,
  type PreparedGhostSections,
} from "dofek/lib/ghost-route-section-results";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import type { ActivitySensorQueryStore, ActivitySensorWindow } from "./activity-sensor-types.ts";
import { ActivityVisibilityRepository } from "./activity-visibility-repository.ts";

type Section = GhostSessionsGetResponse["sections"][number];
export type ReadyTrack = Extract<TrackEvidence, { status: "ready" }>;
type CachedNamedSections = Extract<
  GhostRouteLabelsCacheResult,
  { status: "ready" | "unavailable" }
>["sections"];
type PreparedSection = PreparedGhostSections["sections"][number];
type PreparedPass = PreparedSection["passes"][number];
type PreparedStamp = PreparedGhostSections["anchorStamp"];
export type PreparedRequest = { sectionId: string; passId?: string };
type VisibilityScope = { timezone: string; accessWindow: AccessWindow };
type RouteLabels =
  | {
      status: "ready";
      sections: Section[];
      prepared?: PreparedSection[];
      mapCoverage?: GhostSessionsGetResponse["mapCoverage"];
    }
  | { status: "disabled" | "processing" | "unavailable" | "error" };
export type ServingDatabase = Pick<Database, "execute" | "transaction">;

const namedPrefix = "named:";
export const climbPrefix = "climb:";

export function isPreparedSectionId(sectionId: string): boolean {
  return sectionId.startsWith(namedPrefix) || sectionId.startsWith(climbPrefix);
}

export const analyticsSettings = `SETTINGS join_use_nulls = 1, max_threads = 1,
  enable_materialized_cte = 1, log_queries = 0`;
export const liveOwner = `lower(hex(SHA256(toString({userId:UUID})))) NOT IN (
  SELECT user_hash FROM ingest.account_erasure_fence FINAL
)`;

export function readTrackEvidence(
  store: ActivitySensorQueryStore,
  window: ActivitySensorWindow,
  candidateIds: readonly string[],
) {
  return readGhostTrackEvidence(store.query.bind(store), {
    userId: window.userId,
    activityIds: [window.activityId, ...candidateIds],
  });
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
  candidateId: string,
  proof: unknown,
): Promise<boolean> {
  const parsed = z
    .tuple([savedScalarProofSchema, savedScalarProofSchema])
    .safeParse(typeof proof === "string" ? JSON.parse(proof) : proof);
  if (!parsed.success) return false;
  const [anchor, candidate] = parsed.data;
  if (anchor.activityId !== window.activityId || candidate.activityId !== candidateId) return false;
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

export async function currentComparisonMetrics(
  store: ActivitySensorQueryStore,
  window: ActivitySensorWindow,
  candidateId: string,
  comparison: GhostSessionsCompareResponse,
  proof: unknown,
): Promise<GhostSessionsCompareResponse> {
  if (
    (comparison.metrics.heartRateBpm === null && comparison.metrics.powerWatts === null) ||
    (await verifiesScalars(store, window, candidateId, proof))
  )
    return comparison;
  return {
    ...comparison,
    metrics: { ...comparison.metrics, heartRateBpm: null, powerWatts: null },
  };
}

const sectionSchema = ghostSessionsGetResponseSchema.shape.sections.element;

interface NamedSectionProjection {
  label: Extract<Section, { kind: "named-road" | "named-trail" }>;
  preparedId: string;
}

function namedSections(
  activityId: string,
  sections: CachedNamedSections,
): NamedSectionProjection[] {
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
      sectionId: `${namedPrefix}${id}`,
      suggestedGhost: null,
      anchor: { start, end, elapsedMs: end.timestampMs - start.timestampMs },
    });
    if (!named.success || !("name" in named.data)) return [];
    return [
      {
        label: named.data,
        preparedId: ghostRecordedSectionId(activityId, kind, start.timestampMs, end.timestampMs),
      },
    ];
  });
}

function samePreparedStamp(current: TrackEvidence | undefined, expected: PreparedStamp): boolean {
  return (
    current?.status === "ready" &&
    ghostRouteLabelsSourceVersion(current) ===
      ghostRouteLabelsSourceVersion({ ...expected, status: "ready" })
  );
}

export function preparedSectionDetails(section?: PreparedSection) {
  const latest = section?.passes[0];
  return {
    ...(section?.geometry && { geometry: section.geometry }),
    suggestedGhost: latest ? { passId: latest.passId, reason: "most-recent" as const } : null,
  };
}

// Bind the prepared metadata to the original consenting label and its exact full interval.
function matchingNamedSections(
  names: readonly NamedSectionProjection[],
  prepared: PreparedGhostSections | undefined,
  request: PreparedRequest | undefined,
): PreparedSection[] {
  if (!prepared) return [];
  return prepared.sections.flatMap((section) => {
    if (section.kind === "unnamed-climb") return [];
    const match = names.find(
      ({ label, preparedId }) =>
        preparedId === section.sectionId &&
        label.name === section.name &&
        label.attribution === section.attribution &&
        label.kind === section.kind &&
        JSON.stringify(label.anchor) === JSON.stringify(section.anchor),
    );
    if (!match || (request && match.label.sectionId !== request.sectionId)) return [];
    return [{ ...section, sectionId: match.label.sectionId }];
  });
}

async function currentPreparedSections(
  transaction: TransactionDatabase,
  store: ActivitySensorQueryStore,
  { timezone, accessWindow }: VisibilityScope,
  window: ActivitySensorWindow,
  source: ReadyTrack,
  sections: readonly PreparedSection[],
  candidateStamps: readonly PreparedStamp[],
  request: PreparedRequest | undefined,
) {
  const passId = request?.passId;
  const requestedPasses = sections.flatMap(({ passes }) =>
    passId ? passes.filter((pass) => pass.passId === passId) : passes,
  );
  const candidateIds = [...new Set(requestedPasses.map(({ activityId }) => activityId))];
  const visible = await new ActivityVisibilityRepository(
    transaction,
    window.userId,
    timezone,
    accessWindow,
  ).resolveVisibleActivityIds(candidateIds);
  const selected = passId ? requestedPasses[0] : undefined;
  const selectedComparison =
    selected && visible.has(selected.activityId)
      ? await currentComparisonMetrics(
          store,
          window,
          selected.activityId,
          selected.comparison,
          selected.scalarProof,
        )
      : undefined;

  const checked = candidateStamps.filter(({ activityId }) => visible.has(activityId));
  const current = await readTrackEvidence(
    store,
    window,
    checked.map(({ activityId }) => activityId),
  );
  const active = await resolveActiveGhostMembers(
    transaction,
    window.userId,
    [source, ...checked].map(({ memberActivityId }) => memberActivityId),
  );
  const sourceIsCurrent = (stamp: PreparedStamp) => {
    const member = active.get(stamp.memberActivityId);
    return (
      samePreparedStamp(current.get(stamp.activityId), stamp) &&
      hasActiveMember(active, stamp) &&
      member?.sport === stamp.sport &&
      member.modality === stamp.modality
    );
  };
  if (!sourceIsCurrent(source)) return null;
  const currentIds = new Set(checked.filter(sourceIsCurrent).map(({ activityId }) => activityId));
  currentIds.add(window.activityId);
  const passIsCurrent = (pass: PreparedPass) =>
    visible.has(pass.activityId) && currentIds.has(pass.activityId);
  return sections.map((section) => ({
    ...section,
    passes: passId
      ? selected && selectedComparison && passIsCurrent(selected)
        ? [{ ...selected, comparison: selectedComparison }]
        : []
      : section.passes.filter(passIsCurrent),
  }));
}

async function readRouteLabels(
  db: ServingDatabase,
  store: ActivitySensorQueryStore,
  visibility: VisibilityScope,
  window: ActivitySensorWindow,
  source: ReadyTrack,
  request?: PreparedRequest,
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
    if (!cached && request) return { status: "unavailable" };
    const names = namedSections(window.activityId, cached?.sections ?? []).slice(
      0,
      ghostSectionPreparationLimits.sections,
    );
    const prepared = cached?.prepared;
    return await withAccountErasureUserWriteFence(
      db,
      window.userId,
      async (transaction): Promise<RouteLabels> => {
        const verified = await currentPreparedSections(
          transaction,
          store,
          visibility,
          window,
          source,
          matchingNamedSections(names, prepared, request),
          prepared?.candidateStamps ?? [],
          request,
        );
        if (!verified) return { status: "unavailable" };
        if (
          (await readGhostMapLabelConsent(transaction, window.userId))?.revision !==
          revision.consentRevision
        )
          return { status: "disabled" };
        if (cached) {
          if (
            !request &&
            !prepared &&
            names.length > 0 &&
            cached.expiresAt &&
            cached.expiresAt > Date.now()
          ) {
            await enqueueGhostRouteLabels({ ...revision, prepareOnly: true }).catch(
              (error: unknown) =>
                captureException(error, { tags: { source: "ghost-route-labels-resume" } }),
            );
          }
          const byId = new Map(verified.map((section) => [section.sectionId, section]));
          return {
            status: "ready",
            mapCoverage:
              cached.coverage.bounded ||
              cached.coverage.confirmedWaypoints < cached.coverage.sampledWaypoints
                ? "partial"
                : "complete",
            prepared: verified,
            sections: names.map(({ label }) => ({
              ...label,
              ...preparedSectionDetails(byId.get(label.sectionId)),
            })),
          };
        }
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

async function readRouteClimbs(
  db: ServingDatabase,
  store: ActivitySensorQueryStore,
  visibility: VisibilityScope,
  window: ActivitySensorWindow,
  source: ReadyTrack,
  request?: PreparedRequest,
): Promise<PreparedSection[]> {
  try {
    const key = {
      userId: window.userId,
      activityId: window.activityId,
      sourceVersion: ghostRouteLabelsSourceVersion(source),
    };
    const cached = await readGhostRouteClimbsCache(queryCache, key);
    const sections =
      cached?.prepared.sections.filter(
        (section) => !request || `${climbPrefix}${section.sectionId}` === request.sectionId,
      ) ?? [];
    if (request && sections.length === 0) return [];
    return await withAccountErasureUserWriteFence(db, window.userId, async (transaction) => {
      const verified = await currentPreparedSections(
        transaction,
        store,
        visibility,
        window,
        source,
        sections,
        cached?.prepared.candidateStamps ?? [],
        request,
      );
      if (!verified) return [];
      const proof = cached?.altitudeProof;
      if (proof) {
        const current = await readGhostAltitudeWindowProof(
          store.query.bind(store),
          window.userId,
          proof,
        );
        if (current?.count === proof.count && current.digest === proof.digest) return verified;
      }
      if (!request) await enqueueGhostRouteClimbs(key);
      return [];
    });
  } catch (error: unknown) {
    if (!(error instanceof AccountErasureUserFencedError))
      captureException(error, { tags: { source: "ghost-route-climbs-detail" } });
    return [];
  }
}

export function createGhostPreparedReads(
  db: ServingDatabase,
  store: ActivitySensorQueryStore,
  visibility: VisibilityScope,
) {
  return {
    readLabels: (window: ActivitySensorWindow, source: ReadyTrack, request?: PreparedRequest) =>
      readRouteLabels(db, store, visibility, window, source, request),
    readClimbs: (window: ActivitySensorWindow, source: ReadyTrack, request?: PreparedRequest) =>
      readRouteClimbs(db, store, visibility, window, source, request),
  };
}
