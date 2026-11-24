import { z } from "zod";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { ACCOUNT_ERASURE_FENCE_TABLE } from "../metric-stream/clickhouse-table.ts";
import type { AnalyticsQueryOwner } from "./analytics-query-owner.ts";
import { getGhostHistoryEvidence } from "./ghost-history-evidence.ts";
import {
  auditGhostSessionPage,
  projectGhostSessionsPage,
  refreshGhostSessionPageScalars,
} from "./ghost-sessions-projector.ts";
import {
  ghostTrackInputVersionsMatchSql,
  ghostTrackInputVersionsSql,
  projectGhostTrackIndex,
} from "./ghost-track-index.ts";

type HistoryOwner = Pick<AnalyticsQueryOwner, "client" | "assertActive">;
type QueryClient = Pick<ClickHouseClient, "query">;
type HistoryEvidence = Awaited<ReturnType<typeof getGhostHistoryEvidence>>;
type PublishedPage = Extract<
  Awaited<ReturnType<typeof projectGhostSessionsPage>>,
  { status: "published" }
>;
type ProgressReceipt = { pageReceipt: PublishedPage["pageReceipt"]; request: Cursor | null };

const progressTable = "analytics.ghost_session_history";
const pageTable = "analytics.ghost_session_page";
const anchorBatchSize = 2;
const settings = { join_use_nulls: 1, max_threads: 1, enable_materialized_cte: 1 } as const;
const anchorKeySchema = z.object({ userId: z.uuid(), activityId: z.uuid() });
type AnchorKey = z.infer<typeof anchorKeySchema>;
const cursorSchema = z
  .string()
  .nullable()
  .transform((value) => {
    if (value === null) return null;
    const [startedAt, activityId] = z.tuple([z.iso.datetime(), z.uuid()]).parse(JSON.parse(value));
    return { startedAt, activityId };
  });
const coverageSchema = z.enum(["complete", "partial"]);
const progressSchema = z.object({
  anchorStatus: z.enum(["ready", "pending", "unavailable", "over-limit"]),
  anchorGeneration: z.string().nullable(),
  historyGeneration: z.string().nullable(),
  nextCursor: cursorSchema,
  auditCursor: cursorSchema,
  sourceHistoryCoverage: coverageSchema,
  historyCoverage: coverageSchema,
  comparisonLimited: z.coerce.number().transform((value) => value !== 0),
  refreshVersion: z.string(),
});
type Progress = z.infer<typeof progressSchema>;
type Cursor = NonNullable<Progress["nextCursor"]>;
type ObservedProgress = Omit<Progress, "refreshVersion">;

const anchorKeySql = "user_id = {userId:UUID} AND activity_id = {activityId:UUID}";

function ownerIsLive(user: string): string {
  return `lower(hex(SHA256(toString(${user})))) NOT IN (
    SELECT user_hash FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL
  )`;
}

function cursorKey(cursor: Cursor): string {
  return JSON.stringify([cursor.startedAt, cursor.activityId]);
}

async function queryRows<Schema extends z.ZodType>(
  client: QueryClient,
  schema: Schema,
  query: string,
  queryParams?: Record<string, unknown>,
): Promise<z.infer<Schema>[]> {
  const result = await client.query({
    query,
    query_params: queryParams,
    format: "JSONEachRow",
    clickhouse_settings: settings,
  });
  return schema.array().parse(await result.json());
}

/** Reads the stored pointer for one owner and anchor. Serving must verify current evidence. */
export async function getGhostSessionHistoryProgress(client: QueryClient, key: AnchorKey) {
  const [state] = await queryRows(
    client,
    progressSchema,
    `SELECT anchor_status AS anchorStatus, anchor_generation AS anchorGeneration,
      history_generation AS historyGeneration, next_cursor AS nextCursor,
      audit_cursor AS auditCursor,
      source_history_coverage AS sourceHistoryCoverage, history_coverage AS historyCoverage,
      comparison_limited AS comparisonLimited, toString(refresh_version) AS refreshVersion
    FROM ${progressTable} FINAL WHERE ${anchorKeySql} AND ${ownerIsLive("{userId:UUID}")}`,
    key,
  );
  return state
    ? { ...state, finished: state.historyGeneration !== null && state.nextCursor === null }
    : null;
}

async function selectAnchors(client: QueryClient): Promise<AnchorKey[]> {
  return queryRows(
    client,
    anchorKeySchema,
    `WITH due AS (
      SELECT coalesce(track.user_id, progress.user_id) AS userId,
        coalesce(track.activity_id, progress.activity_id) AS activityId,
        toUInt8(progress.activity_id IS NULL) AS is_new,
        coalesce(progress.refresh_version, track.refresh_version) AS checked_order
      FROM (
        SELECT user_id, activity_id, refresh_version FROM analytics.ghost_track FINAL
        WHERE status = 'ready'
      ) AS track FULL OUTER JOIN (
        SELECT user_id, activity_id, refresh_version FROM ${progressTable} FINAL
      ) AS progress USING (user_id, activity_id)
      WHERE ${ownerIsLive("coalesce(track.user_id, progress.user_id)")}
    )
    SELECT userId, activityId FROM due
    ORDER BY row_number() OVER (PARTITION BY is_new ORDER BY checked_order, userId, activityId),
      is_new DESC LIMIT ${anchorBatchSize}`,
  );
}

const currentPageReceiptSql = `
  WITH observed AS MATERIALIZED (
    SELECT user_id, activity_id,
      toInt64OrNull(JSONExtractString(anchor_stamp, 'gpsSourceRefreshedAtNs')) AS gps_source_refreshed_at_ns,
      toUInt64OrNull(JSONExtractString(anchor_stamp, 'gpsRefreshVersion')) AS gps_refresh_version,
      JSONExtractString(anchor_stamp, 'memberSignature') AS member_signature
    FROM ${pageTable} FINAL WHERE ${anchorKeySql}
      AND anchor_generation = {anchorGeneration:Nullable(String)}
      AND history_generation = {historyGeneration:Nullable(String)}
      AND request_cursor = {requestCursor:String}
      AND payload_digest = {payloadDigest:String} AND refresh_version = {pageVersion:UInt64}
  ), ${ghostTrackInputVersionsSql("observed")}
  SELECT 1 FROM observed LEFT JOIN gps USING (user_id, activity_id)
  LEFT JOIN members USING (user_id, activity_id)
  WHERE ${ghostTrackInputVersionsMatchSql("observed")}
`;

async function writeProgress(
  owner: HistoryOwner,
  key: AnchorKey,
  previous: Progress | null,
  state: ObservedProgress,
  receipt?: ProgressReceipt,
) {
  await owner.assertActive();
  await owner.client.command({
    query: `INSERT INTO ${progressTable} (user_id, activity_id, anchor_status, anchor_generation,
        history_generation, next_cursor, audit_cursor, source_history_coverage, history_coverage,
        comparison_limited, refresh_version)
      SELECT {userId:UUID}, {activityId:UUID}, {anchorStatus:String},
        {anchorGeneration:Nullable(String)}, {historyGeneration:Nullable(String)},
        {nextCursor:Nullable(String)}, {auditCursor:Nullable(String)},
        {sourceHistoryCoverage:String}, {historyCoverage:String},
        {comparisonLimited:UInt8},
        greatest(toUInt64(toUnixTimestamp64Nano(now64(9))), {priorVersion:UInt64} + 1)
      WHERE ${ownerIsLive("{userId:UUID}")}
        ${receipt ? `AND EXISTS (${currentPageReceiptSql})` : ""}`,
    query_params: {
      ...key,
      ...state,
      nextCursor: state.nextCursor ? cursorKey(state.nextCursor) : null,
      auditCursor: state.auditCursor ? cursorKey(state.auditCursor) : null,
      comparisonLimited: Number(state.comparisonLimited),
      priorVersion: previous?.refreshVersion ?? "0",
      ...(receipt && {
        requestCursor: receipt.request ? cursorKey(receipt.request) : "",
        payloadDigest: receipt.pageReceipt.payloadDigest,
        pageVersion: receipt.pageReceipt.refreshVersion,
      }),
    },
    clickhouse_settings: settings,
  });
  const current = await getGhostSessionHistoryProgress(owner.client, key);
  return current && current.refreshVersion !== previous?.refreshVersion ? current : null;
}

async function removeUnreferencedPages(
  owner: HistoryOwner,
  key: AnchorKey,
  current: Progress,
  filter: string,
  filterParams: Record<string, unknown>,
) {
  const obsolete = `${anchorKeySql} AND refresh_version < {progressVersion:UInt64} AND (${filter})`;
  const params = {
    ...key,
    progressVersion: current.refreshVersion,
    ...filterParams,
  };
  const [found] = await queryRows(
    owner.client,
    z.object({ version: z.string() }),
    `SELECT toString(max(refresh_version)) AS version FROM ${pageTable}
    WHERE ${obsolete} AND ${ownerIsLive("{userId:UUID}")}
      AND {progressVersion:UInt64} IN (
        SELECT refresh_version FROM ${progressTable} FINAL WHERE ${anchorKeySql}
      )`,
    params,
  );
  if (!found || found.version === "0") return;
  await owner.assertActive();
  await owner.client.command({
    query: `ALTER TABLE ${pageTable} DELETE WHERE ${obsolete}
      AND refresh_version <= {obsoleteVersion:UInt64}`,
    query_params: { ...params, obsoleteVersion: found.version },
    clickhouse_settings: { mutations_sync: "2" },
  });
}

async function retireObsoletePages(owner: HistoryOwner, key: AnchorKey, current: Progress) {
  if (!current.anchorGeneration || !current.historyGeneration) return;
  await removeUnreferencedPages(
    owner,
    key,
    current,
    `(anchor_generation, history_generation) != ({anchorGeneration:String}, {historyGeneration:String})`,
    { anchorGeneration: current.anchorGeneration, historyGeneration: current.historyGeneration },
  );
}

async function discardAttempt(
  owner: HistoryOwner,
  key: AnchorKey,
  current: Progress,
  attempt: { historyGeneration: string; page: PublishedPage; request: Cursor | null },
) {
  const { historyGeneration, page, request } = attempt;
  const requestCursor = request ? cursorKey(request) : "";
  const nextRequest = current.nextCursor ? cursorKey(current.nextCursor) : null;
  // Within the protected generation only the still-unconsumed request can be discarded.
  if (
    current.anchorGeneration === page.anchorGeneration &&
    current.historyGeneration === historyGeneration &&
    nextRequest !== requestCursor
  )
    return;
  await removeUnreferencedPages(
    owner,
    key,
    current,
    `anchor_generation = {anchorGeneration:String} AND history_generation = {historyGeneration:String}
      AND request_cursor = {requestCursor:String} AND refresh_version <= {pageVersion:UInt64}`,
    {
      anchorGeneration: page.anchorGeneration,
      historyGeneration,
      requestCursor,
      pageVersion: page.pageReceipt.refreshVersion,
    },
  );
}

function observedState(evidence: HistoryEvidence, previous: Progress | null): ObservedProgress {
  return {
    anchorStatus: evidence.anchorStatus,
    anchorGeneration: previous?.anchorGeneration ?? null,
    historyGeneration: previous?.historyGeneration ?? null,
    nextCursor: previous?.nextCursor ?? null,
    auditCursor: previous?.auditCursor ?? null,
    sourceHistoryCoverage: evidence.historyCoverage,
    historyCoverage: "partial",
    comparisonLimited: previous?.comparisonLimited ?? false,
  };
}

function finishedCoverage(state: ObservedProgress) {
  return state.sourceHistoryCoverage === "complete" &&
    state.nextCursor === null &&
    !state.comparisonLimited
    ? "complete"
    : "partial";
}

async function auditFinishedAnchor(
  owner: HistoryOwner,
  key: AnchorKey,
  previous: Progress,
  state: ObservedProgress,
  evidence: HistoryEvidence,
) {
  if (!previous.anchorGeneration || !evidence.historyGeneration) return;
  const request = state.auditCursor;
  const input = {
    ...key,
    anchorGeneration: previous.anchorGeneration,
    historyGeneration: evidence.historyGeneration,
    before: request ?? undefined,
  };
  const audit = await auditGhostSessionPage(owner.client, input);
  let receipt: ProgressReceipt | undefined;
  state.historyCoverage = audit ? finishedCoverage(state) : "partial";
  if (audit?.changed) {
    const pageReceipt = await refreshGhostSessionPageScalars(
      owner,
      { ...input, pointerVersion: previous.refreshVersion },
      audit,
    );
    const after = await getGhostHistoryEvidence(owner.client, key);
    if (after.historyGeneration !== evidence.historyGeneration) {
      await writeProgress(owner, key, previous, observedState(after, previous));
      return;
    }
    if (pageReceipt) receipt = { pageReceipt, request };
  }
  if (audit && (!audit.changed || receipt))
    state.auditCursor = cursorSchema.parse(audit.nextCursor);
  const current = await writeProgress(owner, key, previous, state, receipt);
  if (current) await retireObsoletePages(owner, key, current);
}

async function checkAnchor(owner: HistoryOwner, key: AnchorKey) {
  const previous = await getGhostSessionHistoryProgress(owner.client, key);
  const evidence = await getGhostHistoryEvidence(owner.client, key);
  const state = observedState(evidence, previous);
  if (evidence.anchorStatus !== "ready" || evidence.historyGeneration === null) {
    await writeProgress(owner, key, previous, state);
    return;
  }
  const sameGeneration = previous?.historyGeneration === evidence.historyGeneration;
  if (sameGeneration && previous?.finished) {
    await auditFinishedAnchor(owner, key, previous, state, evidence);
    return;
  }

  const request = sameGeneration ? state.nextCursor : null;
  const page = await projectGhostSessionsPage(owner, {
    ...key,
    historyGeneration: evidence.historyGeneration,
    sourceHistoryCoverage: evidence.historyCoverage === "complete" ? "complete" : "unverified",
    candidateActivityIds: evidence.checkedActivityIds,
    before: request ?? undefined,
  });
  let after = await getGhostHistoryEvidence(owner.client, key);
  if (page.status === "published" && after.historyGeneration === evidence.historyGeneration) {
    const next: ObservedProgress = {
      ...state,
      anchorGeneration: page.anchorGeneration,
      historyGeneration: evidence.historyGeneration,
      nextCursor: page.nextCursor,
      auditCursor: sameGeneration ? state.auditCursor : null,
      comparisonLimited: page.pageReceipt.bounded || (sameGeneration && state.comparisonLimited),
    };
    next.historyCoverage = finishedCoverage(next);
    const current = await writeProgress(owner, key, previous, next, {
      pageReceipt: page.pageReceipt,
      request,
    });
    if (current) {
      await retireObsoletePages(owner, key, current);
      return;
    }
    after = await getGhostHistoryEvidence(owner.client, key);
  }

  const current = await writeProgress(owner, key, previous, observedState(after, previous));
  if (current && page.status === "published")
    await discardAttempt(owner, key, current, {
      historyGeneration: evidence.historyGeneration,
      page,
      request,
    });
}

/** Advances one compact index batch and at most one page for each selected anchor. */
export async function runGhostSessionHistory(owner: HistoryOwner) {
  const result = await projectGhostTrackIndex(owner);
  const anchors = await selectAnchors(owner.client);
  for (const key of anchors) await checkAnchor(owner, key);
  return { ...result, checkedAnchors: anchors.length };
}
