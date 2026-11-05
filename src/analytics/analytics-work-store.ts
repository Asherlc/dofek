import { sql } from "drizzle-orm";
import { z } from "zod";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import type { Database } from "../db/index.ts";
import { executeWithSchema, type SchemaExecutionDatabase } from "../db/typed-sql.ts";
import {
  compareMetricStreamPositions,
  type MetricStreamPosition,
  metricStreamPositionSchema,
} from "../metric-stream/transport-position.ts";
import {
  PROCESSING_DATASET_KEYS,
  type ProcessingDatasetKey,
} from "../processing/dataset-contracts.ts";
import {
  type AnalyticsDeliveryGroup,
  analyticsDeliveryGroupIngestionTimes,
  analyticsDeliveryGroupIntentId,
  describeAnalyticsDeliveryGroup,
  type PersistedAnalyticsDeliveryGroup,
} from "./analytics-delivery-group.ts";
import { loadAnalyticsRunFrontier } from "./analytics-run-frontier.ts";
import { type AnalyticsStage, verifyAnalyticsDeliveryReceipt } from "./effect-journal.ts";
import { verifyAnalyticsDeliveryReceipts } from "./effect-journal-group.ts";
import {
  type AnalyticsEffectCursor,
  type AnalyticsStream,
  assertPositionStream,
  journalDeliveryKey,
  journalDeliveryKeySchema,
  metricStreamPositionIdentity,
  positionAtJournalKey,
} from "./journal-position.ts";

export interface RequiredAnalyticsFrontier {
  operationId: string;
  datasetKey: ProcessingDatasetKey;
  stream: AnalyticsStream;
  position: MetricStreamPosition;
}

export async function loadAnalyticsPageState(
  database: Database,
  input: { runId: string; stage: AnalyticsStage; stream: AnalyticsStream },
) {
  return database.transaction(async (transaction) => {
    const run = await lockRun(transaction, input.runId);
    if (!run.sealed) throw new Error("Analytics page requires a sealed run");
    const rows = await executeWithSchema(
      transaction,
      z.object({ cursor: cursorSchema.nullable() }),
      sql`SELECT cursor FROM fitness.analytics_stage_cursor WHERE run_id=${input.runId} AND stage=${input.stage} AND ${streamWhere(input.stream)}`,
    );
    return { ownerId: run.owner_id, cursor: rows[0]?.cursor ?? null };
  });
}

export async function admitAnalyticsPage(
  database: Database,
  input: {
    runId: string;
    ownerId: string;
    stage: AnalyticsStage;
    stream: AnalyticsStream;
    pageSize: number;
    publicationRevision: string;
  },
) {
  z.number().int().min(1).max(20).parse(input.pageSize);
  z.string()
    .regex(/^[1-9]\d*$/)
    .refine((value) => BigInt(value) <= 18446744073709551615n)
    .parse(input.publicationRevision);
  return database.transaction(async (transaction) => {
    const run = await lockRun(transaction, input.runId);
    if (!run.sealed || run.owner_id !== input.ownerId)
      throw new Error("Analytics page admission requires its current sealed-run owner");
    const rows = await executeWithSchema(
      transaction,
      z.object({
        cursor: cursorSchema.nullable(),
        page_after: cursorSchema.nullable(),
        page_size: z.number().nullable(),
        page_publication_revision: z.string().nullable(),
        page_state: z.enum(["pending", "completed"]).nullable(),
        page_next: cursorSchema.nullable(),
        page_output_complete: z.boolean(),
      }),
      sql`SELECT cursor,page_after,page_size,page_publication_revision,page_state,page_next,page_output_complete FROM fitness.analytics_stage_cursor WHERE run_id=${input.runId} AND stage=${input.stage} AND ${streamWhere(input.stream)} FOR UPDATE`,
    );
    const row = rows[0];
    if (row?.page_state === "pending") {
      if (
        row.page_size === null ||
        row.page_publication_revision === null ||
        JSON.stringify(row.cursor) !== JSON.stringify(row.page_after)
      )
        throw new Error("Pending analytics page has an inconsistent descriptor or cursor");
      if (!row.page_output_complete)
        await transaction.execute(
          sql`UPDATE fitness.analytics_stage_cursor SET page_publication_revision=${input.publicationRevision}::numeric WHERE run_id=${input.runId} AND stage=${input.stage} AND ${streamWhere(input.stream)}`,
        );
      return {
        after: row.page_after,
        pageSize: row.page_size,
        publicationRevision: row.page_output_complete
          ? row.page_publication_revision
          : input.publicationRevision,
        state: row.page_state,
        next: row.page_next,
        outputComplete: row.page_output_complete,
      };
    }
    if (
      row?.page_state === "completed" &&
      JSON.stringify(row.page_next) !== JSON.stringify(row.cursor)
    )
      throw new Error("Completed analytics page no longer matches its exact cursor");
    const after = row?.cursor ?? null;
    await transaction.execute(sql`INSERT INTO fitness.analytics_stage_cursor (run_id,stage,transport,epoch,topic,partition,cursor,page_after,page_size,page_publication_revision,page_state,page_next)
      VALUES (${input.runId},${input.stage},${input.stream.transport},${input.stream.epoch},${input.stream.topic},${input.stream.partition},${after === null ? null : JSON.stringify(after)}::jsonb,${after === null ? null : JSON.stringify(after)}::jsonb,${input.pageSize},${input.publicationRevision}::numeric,'pending',NULL)
      ON CONFLICT (run_id,stage,transport,epoch,topic,partition) DO UPDATE SET page_after=EXCLUDED.page_after,page_size=EXCLUDED.page_size,page_publication_revision=EXCLUDED.page_publication_revision,page_state='pending',page_next=NULL,page_output_complete=false,page_effects_digest=NULL`);
    return {
      after,
      pageSize: input.pageSize,
      publicationRevision: input.publicationRevision,
      state: "pending" as const,
      next: null,
      outputComplete: false,
    };
  });
}

export async function captureAnalyticsPage(
  database: Database,
  input: {
    runId: string;
    ownerId: string;
    stage: AnalyticsStage;
    stream: AnalyticsStream;
    publicationRevision: string;
    next: AnalyticsEffectCursor | null;
    effectsDigest: string;
  },
): Promise<void> {
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.effectsDigest);
  await database.transaction(async (transaction) => {
    const run = await lockRun(transaction, input.runId);
    if (run.owner_id !== input.ownerId)
      throw new Error("Analytics page owner changed before membership capture");
    const rows = await executeWithSchema(
      transaction,
      changedSchema,
      sql`UPDATE fitness.analytics_stage_cursor SET page_next=${input.next === null ? null : JSON.stringify(input.next)}::jsonb,page_effects_digest=${input.effectsDigest}
      WHERE run_id=${input.runId} AND stage=${input.stage} AND ${streamWhere(input.stream)} AND page_state='pending' AND page_publication_revision=${input.publicationRevision}::numeric
      AND (page_effects_digest IS NULL OR (page_effects_digest=${input.effectsDigest} AND page_next IS NOT DISTINCT FROM ${input.next === null ? null : JSON.stringify(input.next)}::jsonb)) RETURNING 1 AS changed`,
    );
    if (rows.length !== 1)
      throw new Error(
        "Captured analytics page membership changed; preserve its pending work and reconcile missing receipts",
      );
  });
}

export async function markAnalyticsPageOutputComplete(
  database: Database,
  input: {
    runId: string;
    ownerId: string;
    stage: AnalyticsStage;
    stream: AnalyticsStream;
    publicationRevision: string;
  },
): Promise<void> {
  await database.transaction(async (transaction) => {
    const run = await lockRun(transaction, input.runId);
    if (run.owner_id !== input.ownerId)
      throw new Error("Analytics page owner changed before output proof");
    const rows = await executeWithSchema(
      transaction,
      changedSchema,
      sql`UPDATE fitness.analytics_stage_cursor SET page_output_complete=true WHERE run_id=${input.runId} AND stage=${input.stage} AND ${streamWhere(input.stream)} AND page_state='pending' AND page_effects_digest IS NOT NULL AND page_publication_revision=${input.publicationRevision}::numeric AND cursor IS NOT DISTINCT FROM page_after RETURNING 1 AS changed`,
    );
    if (rows.length !== 1)
      throw new Error("Analytics output proof no longer matches its exact page attempt");
  });
}

export async function completeAnalyticsEmptyPage(
  database: Database,
  input: {
    runId: string;
    ownerId: string;
    stage: AnalyticsStage;
    stream: AnalyticsStream;
    publicationRevision: string;
  },
) {
  await database.transaction(async (transaction) => {
    const run = await lockRun(transaction, input.runId);
    if (run.owner_id !== input.ownerId)
      throw new Error("Analytics page owner changed before empty completion");
    const rows = await executeWithSchema(
      transaction,
      changedSchema,
      sql`UPDATE fitness.analytics_stage_cursor SET page_state='completed',page_next=cursor,page_output_complete=true
      WHERE run_id=${input.runId} AND stage=${input.stage} AND ${streamWhere(input.stream)} AND page_state='pending'
      AND page_publication_revision=${input.publicationRevision}::numeric AND cursor IS NOT DISTINCT FROM page_after RETURNING 1 AS changed`,
    );
    if (rows.length !== 1)
      throw new Error("Analytics empty page descriptor changed before completion");
  });
}

/** Recheck after structural discovery; CH erasure must subsequently join the same query owner. */
export async function assertAnalyticsPageAccountsActive(
  database: Database,
  userIds: readonly string[],
): Promise<void> {
  const ids = z
    .array(z.uuid())
    .max(40)
    .parse([...new Set(userIds)]);
  if (!ids.length) return;
  const rows = await executeWithSchema(
    database,
    z.object({ id: z.uuid() }),
    sql`SELECT profile.id FROM fitness.user_profile AS profile WHERE profile.id IN (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`,`,
    )}) AND NOT EXISTS (SELECT 1 FROM fitness.account_erasure_request AS erasure WHERE erasure.user_id=profile.id AND erasure.status<>'completed')`,
  );
  if (rows.length !== ids.length)
    throw new Error(
      "Analytics page contains a missing account or active account erasure; finish erasure before retrying this page",
    );
}
// A successful CAS fences checkpoints. The caller must first establish that the
// previous writer and its server-side queries are terminal before transferring ownership.
export async function claimAnalyticsRunOwnership(
  database: Database,
  input: { runId: string; expectedOwnerId: string | null; ownerId: string },
): Promise<void> {
  z.uuid().parse(input.ownerId);
  await database.transaction(async (transaction) => {
    const run = await lockRun(transaction, input.runId);
    if (!run.sealed)
      throw new Error("Analytics run must be sealed before writer ownership is claimed");
    if (run.owner_id === input.ownerId) return;
    if (run.owner_id !== input.expectedOwnerId)
      throw new Error("Analytics run owner changed; stale writer cannot claim ownership");
    await transaction.execute(
      sql`UPDATE fitness.analytics_run SET owner_id=${input.ownerId} WHERE id=${input.runId}`,
    );
  });
}
interface DeliveryInput {
  stream: AnalyticsStream;
  ownerId: string;
  position: MetricStreamPosition;
}
const streamStateSchema = z.object({
  owner_id: z.uuid(),
  processed: metricStreamPositionSchema.nullable(),
  pending: metricStreamPositionSchema.nullable(),
  group_state: z.enum(["pending", "completed"]).nullable(),
  group_first_position: metricStreamPositionSchema.nullable(),
  group_last_position: metricStreamPositionSchema.nullable(),
  group_member_count: z.number().int().min(1).max(500).nullable(),
  group_positions_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  group_first_ingested_at: z.iso.datetime({ precision: 6 }).nullable(),
});
const streamStateColumns = sql`owner_id,processed,pending,group_state,
  group_first_position,group_last_position,group_member_count,group_positions_digest,
  to_char(group_first_ingested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS group_first_ingested_at`;
const cursorSchema = z.object({
  delivery: journalDeliveryKeySchema,
  effectOrdinal: z
    .string()
    .regex(/^(-1|0|[1-9]\d*)$/)
    .refine((value) => BigInt(value) <= 18446744073709551615n),
});
const changedSchema = z.object({ changed: z.number() });

async function lockRun(database: SchemaExecutionDatabase, runId: string) {
  const [run] = await executeWithSchema(
    database,
    z.object({ owner_id: z.uuid().nullable(), sealed: z.boolean() }),
    sql`SELECT owner_id,sealed FROM fitness.analytics_run WHERE id=${runId} FOR UPDATE`,
  );
  if (!run) throw new Error("Analytics run is missing; create and seal its finite frontier first");
  return run;
}

function streamWhere(stream: AnalyticsStream) {
  return sql`transport=${stream.transport} AND epoch=${stream.epoch} AND topic=${stream.topic} AND partition=${stream.partition}`;
}
function samePosition(left: MetricStreamPosition | null, right: MetricStreamPosition | null) {
  return left === null || right === null
    ? left === right
    : compareMetricStreamPositions(left, right) === 0 &&
        metricStreamPositionIdentity(left) === metricStreamPositionIdentity(right);
}
function decodeStreamState(row: z.infer<typeof streamStateSchema>, stream: AnalyticsStream) {
  if (row.processed) assertPositionStream(row.processed, stream);
  if (row.pending) assertPositionStream(row.pending, stream);
  const fields = [
    row.group_state,
    row.group_first_position,
    row.group_last_position,
    row.group_member_count,
    row.group_positions_digest,
    row.group_first_ingested_at,
  ];
  let group: PersistedAnalyticsDeliveryGroup | null = null;
  if (fields.some((field) => field !== null)) {
    if (
      row.group_state === null ||
      !row.group_first_position ||
      !row.group_last_position ||
      row.group_member_count === null ||
      row.group_positions_digest === null ||
      row.group_first_ingested_at === null
    )
      throw new Error("Analytics delivery group membership descriptor is incomplete");
    assertPositionStream(row.group_first_position, stream);
    assertPositionStream(row.group_last_position, stream);
    const order = compareMetricStreamPositions(row.group_first_position, row.group_last_position);
    if (
      (row.group_member_count === 1 &&
        !samePosition(row.group_first_position, row.group_last_position)) ||
      (row.group_member_count > 1 && order >= 0)
    )
      throw new Error("Analytics delivery group membership has inconsistent boundaries or count");
    if (
      row.group_state === "pending" &&
      (!samePosition(row.pending, row.group_last_position) ||
        (row.processed &&
          compareMetricStreamPositions(row.group_first_position, row.processed) <= 0))
    )
      throw new Error("Analytics pending group does not match its delivery frontier");
    if (
      row.group_state === "completed" &&
      (row.pending !== null || !samePosition(row.processed, row.group_last_position))
    )
      throw new Error("Analytics completed group does not match its processed frontier");
    const description = {
      stream,
      first: row.group_first_position,
      last: row.group_last_position,
      memberCount: row.group_member_count,
      positionsDigest: row.group_positions_digest,
    };
    group = {
      ...description,
      ingestedAt: row.group_first_ingested_at,
      intentId: analyticsDeliveryGroupIntentId(description),
    };
  }
  return {
    owner_id: row.owner_id,
    processed: row.processed,
    pending: row.pending,
    pendingGroup: row.group_state === "pending" ? group : null,
    completedGroup: row.group_state === "completed" ? group : null,
  };
}
function sameGroup(left: AnalyticsDeliveryGroup, right: AnalyticsDeliveryGroup) {
  return (
    samePosition(left.first, right.first) &&
    samePosition(left.last, right.last) &&
    left.memberCount === right.memberCount &&
    left.positionsDigest === right.positionsDigest
  );
}
async function lockStream(database: SchemaExecutionDatabase, stream: AnalyticsStream) {
  const [state] = await executeWithSchema(
    database,
    streamStateSchema,
    sql`SELECT ${streamStateColumns} FROM fitness.analytics_stream_state WHERE ${streamWhere(stream)} FOR UPDATE`,
  );
  if (!state)
    throw new Error(
      "Analytics stream ownership is missing; claim this stream before processing deliveries",
    );
  return decodeStreamState(state, stream);
}

export async function claimAnalyticsStream(
  database: Database,
  input: { stream: AnalyticsStream; ownerId: string; expectedOwnerId: string | null },
): Promise<void> {
  z.uuid().parse(input.ownerId);
  await database.transaction(async (transaction) => {
    if (input.expectedOwnerId === null) {
      const inserted = await executeWithSchema(
        transaction,
        changedSchema,
        sql`INSERT INTO fitness.analytics_stream_state (transport,epoch,topic,partition,owner_id) VALUES (${input.stream.transport},${input.stream.epoch},${input.stream.topic},${input.stream.partition},${input.ownerId}) ON CONFLICT DO NOTHING RETURNING 1 AS changed`,
      );
      if (inserted.length) return;
    }
    const state = await lockStream(transaction, input.stream);
    if (state.owner_id === input.ownerId) return;
    if (state.owner_id !== input.expectedOwnerId)
      throw new Error("Analytics stream owner changed; stale consumer cannot claim the stream");
    await transaction.execute(
      sql`UPDATE fitness.analytics_stream_state SET owner_id=${input.ownerId} WHERE ${streamWhere(input.stream)}`,
    );
  });
}

/** Publication ownership serializes callers; transport ownership still comes from assertActive. */
export async function loadAnalyticsStreamState(database: Database, stream: AnalyticsStream) {
  const rows = await executeWithSchema(
    database,
    streamStateSchema,
    sql`SELECT ${streamStateColumns} FROM fitness.analytics_stream_state WHERE ${streamWhere(stream)}`,
  );
  return rows[0] ? decodeStreamState(rows[0], stream) : null;
}

export async function beginAnalyticsDelivery(
  database: Database,
  input: DeliveryInput & { expected: MetricStreamPosition | null },
): Promise<void> {
  assertPositionStream(input.position, input.stream);
  await database.transaction(async (transaction) => {
    const state = await lockStream(transaction, input.stream);
    if (state.owner_id !== input.ownerId) throw new Error("Analytics delivery owner is stale");
    if (state.pendingGroup || state.completedGroup)
      throw new Error("Analytics pending group requires exact original membership replay");
    if (!samePosition(state.processed, input.expected))
      throw new Error("Analytics processed frontier changed; ordered delivery admission rejected");
    if (state.processed && compareMetricStreamPositions(input.position, state.processed) <= 0)
      throw new Error("Out-of-order analytics delivery admission rejected");
    if (state.pending && !samePosition(state.pending, input.position))
      throw new Error("Prior ordered analytics delivery has no complete receipt");
    await transaction.execute(
      sql`UPDATE fitness.analytics_stream_state SET pending=${JSON.stringify(input.position)}::jsonb WHERE ${streamWhere(input.stream)}`,
    );
  });
}

export async function beginAnalyticsDeliveryGroup(
  database: Database,
  input: {
    stream: AnalyticsStream;
    ownerId: string;
    positions: readonly MetricStreamPosition[];
    maximum: number;
    expected: MetricStreamPosition | null;
    ingestedAt: string;
  },
): Promise<void> {
  const group = describeAnalyticsDeliveryGroup(input.positions, input.maximum);
  assertPositionStream(group.first, input.stream);
  if (input.expected) assertPositionStream(input.expected, input.stream);
  z.uuid().parse(input.ownerId);
  analyticsDeliveryGroupIngestionTimes(input.ingestedAt, 1);
  await database.transaction(async (transaction) => {
    const state = await lockStream(transaction, input.stream);
    if (state.owner_id !== input.ownerId)
      throw new Error("Analytics delivery group owner is stale");
    if (!samePosition(state.processed, input.expected))
      throw new Error("Analytics processed frontier changed; ordered group admission rejected");
    if (state.processed && compareMetricStreamPositions(group.first, state.processed) <= 0)
      throw new Error("Out-of-order analytics delivery group admission rejected");
    if (state.pendingGroup) {
      if (!sameGroup(state.pendingGroup, group))
        throw new Error(
          "Analytics pending group membership changed; reassemble the original group",
        );
      return;
    }
    if (state.pending)
      throw new Error("Prior ordered analytics delivery has no complete receipt before this group");
    analyticsDeliveryGroupIngestionTimes(input.ingestedAt, group.memberCount);
    await transaction.execute(sql`UPDATE fitness.analytics_stream_state
      SET pending=${JSON.stringify(group.last)}::jsonb,
        group_state='pending',group_first_position=${JSON.stringify(group.first)}::jsonb,
        group_last_position=${JSON.stringify(group.last)}::jsonb,
        group_member_count=${group.memberCount},group_positions_digest=${group.positionsDigest},
        group_first_ingested_at=${input.ingestedAt}::timestamptz
      WHERE ${streamWhere(input.stream)}`);
  });
}

export async function completeAnalyticsDeliveryGroup(
  database: Database,
  client: ClickHouseClient,
  input: {
    stream: AnalyticsStream;
    ownerId: string;
    positions: readonly MetricStreamPosition[];
    maximum: number;
  },
): Promise<void> {
  const positions = input.positions.map((position) => metricStreamPositionSchema.parse(position));
  const group = describeAnalyticsDeliveryGroup(positions, input.maximum);
  assertPositionStream(group.first, input.stream);
  z.uuid().parse(input.ownerId);
  await verifyAnalyticsDeliveryReceipts(client, positions);
  await database.transaction(async (transaction) => {
    const state = await lockStream(transaction, input.stream);
    if (state.owner_id !== input.ownerId)
      throw new Error("Analytics delivery group owner is stale");
    if (state.completedGroup) {
      if (!sameGroup(state.completedGroup, group))
        throw new Error("Analytics completed group membership differs from its original group");
      return;
    }
    if (!state.pendingGroup || !sameGroup(state.pendingGroup, group))
      throw new Error("Analytics delivery group membership was not admitted in order");
    if (state.processed && compareMetricStreamPositions(group.first, state.processed) <= 0)
      throw new Error("Analytics processed frontier changed before group completion");
    await transaction.execute(sql`UPDATE fitness.analytics_stream_state
      SET processed=group_last_position,pending=NULL,group_state='completed'
      WHERE ${streamWhere(input.stream)}`);
  });
}

export async function completeAnalyticsDelivery(
  database: Database,
  client: ClickHouseClient,
  input: DeliveryInput,
): Promise<void> {
  assertPositionStream(input.position, input.stream);
  await verifyAnalyticsDeliveryReceipt(client, input.position);
  await database.transaction(async (transaction) => {
    const state = await lockStream(transaction, input.stream);
    if (state.owner_id !== input.ownerId) throw new Error("Analytics delivery owner is stale");
    if (state.pendingGroup || state.completedGroup)
      throw new Error("Analytics pending group requires proof of every original member receipt");
    if (samePosition(state.processed, input.position) && state.pending === null) return;
    if (!samePosition(state.pending, input.position))
      throw new Error(
        "Analytics delivery was not admitted in order; receipt cannot advance frontier",
      );
    await transaction.execute(
      sql`UPDATE fitness.analytics_stream_state SET processed=pending,pending=NULL WHERE ${streamWhere(input.stream)}`,
    );
  });
}

export async function sealAnalyticsRun(
  database: Database,
  input: { runId: string; frontiers: readonly RequiredAnalyticsFrontier[] },
): Promise<void> {
  z.uuid().parse(input.runId);
  if (!input.frontiers.length)
    throw new Error("A finite analytics run requires a nonempty required frontier vector");
  const frontiers = [...input.frontiers].sort((left, right) =>
    JSON.stringify([left.stream, left.operationId, left.datasetKey]).localeCompare(
      JSON.stringify([right.stream, right.operationId, right.datasetKey]),
    ),
  );
  for (const frontier of frontiers) {
    assertPositionStream(frontier.position, frontier.stream);
    z.enum(PROCESSING_DATASET_KEYS).parse(frontier.datasetKey);
  }
  await database.transaction(async (transaction) => {
    await transaction.execute(
      sql`INSERT INTO fitness.analytics_run(id) VALUES (${input.runId}) ON CONFLICT DO NOTHING`,
    );
    const [run] = await executeWithSchema(
      transaction,
      z.object({ sealed: z.boolean() }),
      sql`SELECT sealed FROM fitness.analytics_run WHERE id=${input.runId} FOR UPDATE`,
    );
    if (!run) throw new Error("Analytics run is missing");
    if (run.sealed) {
      const existing = await executeWithSchema(
        transaction,
        z.object({
          operation_id: z.uuid(),
          dataset_key: z.enum(PROCESSING_DATASET_KEYS),
          transport: z.enum(["pulsar", "kafka"]),
          epoch: z.string(),
          topic: z.string(),
          partition: z.number(),
          position: metricStreamPositionSchema,
        }),
        sql`SELECT operation_id,dataset_key,transport,epoch,topic,partition,position FROM fitness.analytics_required_frontier WHERE run_id=${input.runId}`,
      );
      const identity = (frontier: RequiredAnalyticsFrontier) =>
        JSON.stringify([
          frontier.stream.epoch,
          frontier.stream.transport,
          frontier.stream.topic,
          frontier.stream.partition,
          frontier.operationId,
          frontier.datasetKey,
          metricStreamPositionIdentity(frontier.position),
          journalDeliveryKey(frontier.position),
        ]);
      const actual = existing
        .map((row) =>
          identity({
            operationId: row.operation_id,
            datasetKey: row.dataset_key,
            stream: row,
            position: row.position,
          }),
        )
        .sort();
      const expected = frontiers.map(identity).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(
          "Analytics run is already sealed; its required frontier vector is immutable",
        );
      return;
    }
    for (const frontier of frontiers) {
      const state = await lockStream(transaction, frontier.stream);
      if (!state.processed || compareMetricStreamPositions(state.processed, frontier.position) < 0)
        throw new Error(
          "Analytics processed delivery frontier does not cover the required receipt",
        );
      const inserted = await executeWithSchema(
        transaction,
        changedSchema,
        sql`INSERT INTO fitness.analytics_required_frontier(run_id,operation_id,user_id,dataset_key,transport,epoch,topic,partition,position)
        SELECT ${input.runId},id,user_id,${frontier.datasetKey},${frontier.stream.transport},${frontier.stream.epoch},${frontier.stream.topic},${frontier.stream.partition},${JSON.stringify(frontier.position)}::jsonb FROM fitness.processing_operation
        WHERE id=${frontier.operationId} AND ${frontier.datasetKey}=ANY(dataset_keys) RETURNING 1 AS changed`,
      );
      if (!inserted.length)
        throw new Error("Required analytics operation or dataset ownership is missing");
    }
    await transaction.execute(
      sql`UPDATE fitness.analytics_run SET sealed=true WHERE id=${input.runId}`,
    );
  });
}

export async function checkpointAnalyticsPage(
  database: Database,
  input: {
    runId: string;
    ownerId: string;
    stage: AnalyticsStage;
    stream: AnalyticsStream;
    expected: AnalyticsEffectCursor | null;
    next: AnalyticsEffectCursor;
    publicationRevision?: string;
  },
): Promise<void> {
  z.uuid().parse(input.ownerId);
  await database.transaction(async (transaction) => {
    const run = await lockRun(transaction, input.runId);
    if (run.owner_id !== input.ownerId)
      throw new Error("Analytics run owner changed; stale writer cannot checkpoint");
    const next = cursorSchema.parse(input.next);
    if (input.expected) cursorSchema.parse(input.expected);
    z.enum(["scalar", "dedup", "activity"]).parse(input.stage);
    const frontier = await loadAnalyticsRunFrontier(transaction, input);
    const nextPosition = positionAtJournalKey(frontier, next.delivery);
    if (
      compareMetricStreamPositions(nextPosition, frontier) > 0 ||
      (input.expected &&
        (compareMetricStreamPositions(
          nextPosition,
          positionAtJournalKey(frontier, input.expected.delivery),
        ) < 0 ||
          (compareMetricStreamPositions(
            nextPosition,
            positionAtJournalKey(frontier, input.expected.delivery),
          ) === 0 &&
            BigInt(next.effectOrdinal) <= BigInt(input.expected.effectOrdinal))))
    )
      throw new Error("Analytics cursor must advance within its sealed frontier");
    const expected = input.expected === null ? null : JSON.stringify(input.expected);
    const changed = await executeWithSchema(
      transaction,
      changedSchema,
      input.publicationRevision !== undefined
        ? sql`UPDATE fitness.analytics_stage_cursor SET cursor=${JSON.stringify(next)}::jsonb,page_state='completed',page_next=${JSON.stringify(next)}::jsonb
          WHERE run_id=${input.runId} AND stage=${input.stage} AND ${streamWhere(input.stream)}
            AND cursor IS NOT DISTINCT FROM ${expected}::jsonb AND page_after IS NOT DISTINCT FROM ${expected}::jsonb
            AND page_state='pending' AND page_output_complete AND page_effects_digest IS NOT NULL
            AND page_next=${JSON.stringify(next)}::jsonb AND page_publication_revision=${input.publicationRevision}::numeric RETURNING 1 AS changed`
        : input.expected === null
          ? sql`INSERT INTO fitness.analytics_stage_cursor(run_id,stage,transport,epoch,topic,partition,cursor)
    VALUES (${input.runId},${input.stage},${input.stream.transport},${input.stream.epoch},${input.stream.topic},${input.stream.partition},${JSON.stringify(next)}::jsonb)
    ON CONFLICT DO NOTHING RETURNING 1 AS changed`
          : sql`UPDATE fitness.analytics_stage_cursor SET cursor=${JSON.stringify(next)}::jsonb WHERE run_id=${input.runId} AND stage=${input.stage} AND ${streamWhere(input.stream)} AND cursor=${expected}::jsonb RETURNING 1 AS changed`,
    );
    if (!changed.length)
      throw new Error("Analytics cursor changed; stale page owner cannot checkpoint");
  });
}
