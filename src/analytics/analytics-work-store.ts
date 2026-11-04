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
  type AnalyticsEffectCursor,
  type AnalyticsStage,
  type AnalyticsStream,
  verifyAnalyticsDeliveryReceipt,
} from "./effect-journal.ts";

export interface RequiredAnalyticsFrontier {
  operationId: string;
  datasetKey: ProcessingDatasetKey;
  stream: AnalyticsStream;
  position: MetricStreamPosition;
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
});
const cursorSchema = z.object({
  delivery: metricStreamPositionSchema.shape.delivery,
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
  return sql`epoch=${stream.epoch} AND topic=${stream.topic} AND partition=${stream.partition}`;
}
function samePosition(left: MetricStreamPosition | null, right: MetricStreamPosition | null) {
  return left === null || right === null
    ? left === right
    : compareMetricStreamPositions(left, right) === 0 &&
        left.serializedMessageId === right.serializedMessageId;
}
function assertPositionStream(position: MetricStreamPosition, stream: AnalyticsStream) {
  metricStreamPositionSchema.parse(position);
  compareMetricStreamPositions(position, { ...position, ...stream });
}
async function lockStream(database: SchemaExecutionDatabase, stream: AnalyticsStream) {
  const [state] = await executeWithSchema(
    database,
    streamStateSchema,
    sql`SELECT owner_id,processed,pending FROM fitness.analytics_stream_state WHERE ${streamWhere(stream)} FOR UPDATE`,
  );
  if (!state)
    throw new Error(
      "Analytics stream ownership is missing; claim this stream before processing deliveries",
    );
  return state;
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
        sql`INSERT INTO fitness.analytics_stream_state (epoch,topic,partition,owner_id) VALUES (${input.stream.epoch},${input.stream.topic},${input.stream.partition},${input.ownerId}) ON CONFLICT DO NOTHING RETURNING 1 AS changed`,
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

export async function beginAnalyticsDelivery(
  database: Database,
  input: DeliveryInput & { expected: MetricStreamPosition | null },
): Promise<void> {
  assertPositionStream(input.position, input.stream);
  await database.transaction(async (transaction) => {
    const state = await lockStream(transaction, input.stream);
    if (state.owner_id !== input.ownerId) throw new Error("Analytics delivery owner is stale");
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
          epoch: z.string(),
          topic: z.string(),
          partition: z.number(),
          position: metricStreamPositionSchema,
        }),
        sql`SELECT operation_id,dataset_key,epoch,topic,partition,position FROM fitness.analytics_required_frontier WHERE run_id=${input.runId}`,
      );
      const identity = (frontier: RequiredAnalyticsFrontier) =>
        JSON.stringify([
          frontier.stream.epoch,
          frontier.stream.topic,
          frontier.stream.partition,
          frontier.operationId,
          frontier.datasetKey,
          frontier.position.serializedMessageId,
          frontier.position.delivery.major,
          frontier.position.delivery.minor,
          frontier.position.delivery.batch,
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
        sql`INSERT INTO fitness.analytics_required_frontier(run_id,operation_id,user_id,dataset_key,epoch,topic,partition,position)
        SELECT ${input.runId},id,user_id,${frontier.datasetKey},${frontier.stream.epoch},${frontier.stream.topic},${frontier.stream.partition},${JSON.stringify(frontier.position)}::jsonb FROM fitness.processing_operation
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

export async function loadAnalyticsRunFrontier(
  database: SchemaExecutionDatabase,
  input: { runId: string; stream: AnalyticsStream },
): Promise<MetricStreamPosition> {
  const rows = await executeWithSchema(
    database,
    z.object({ position: metricStreamPositionSchema }),
    sql`SELECT frontier.position FROM fitness.analytics_required_frontier AS frontier JOIN fitness.analytics_run AS run ON run.id=frontier.run_id WHERE run.id=${input.runId} AND run.sealed AND frontier.epoch=${input.stream.epoch} AND frontier.topic=${input.stream.topic} AND frontier.partition=${input.stream.partition}`,
  );
  let result: MetricStreamPosition | null = null;
  for (const row of rows) {
    assertPositionStream(row.position, input.stream);
    if (!result || compareMetricStreamPositions(row.position, result) > 0) result = row.position;
  }
  if (!result)
    throw new Error("Required sealed analytics frontier is missing; the run cannot complete");
  return result;
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
    const nextPosition = { ...frontier, delivery: next.delivery };
    if (
      compareMetricStreamPositions(nextPosition, frontier) > 0 ||
      (input.expected &&
        (compareMetricStreamPositions(nextPosition, {
          ...frontier,
          delivery: input.expected.delivery,
        }) < 0 ||
          (compareMetricStreamPositions(nextPosition, {
            ...frontier,
            delivery: input.expected.delivery,
          }) === 0 &&
            BigInt(next.effectOrdinal) <= BigInt(input.expected.effectOrdinal))))
    )
      throw new Error("Analytics cursor must advance within its sealed frontier");
    const expected = input.expected === null ? null : JSON.stringify(input.expected);
    const changed = await executeWithSchema(
      transaction,
      changedSchema,
      input.expected === null
        ? sql`INSERT INTO fitness.analytics_stage_cursor(run_id,stage,epoch,topic,partition,cursor)
    VALUES (${input.runId},${input.stage},${input.stream.epoch},${input.stream.topic},${input.stream.partition},${JSON.stringify(next)}::jsonb)
    ON CONFLICT DO NOTHING RETURNING 1 AS changed`
        : sql`UPDATE fitness.analytics_stage_cursor SET cursor=${JSON.stringify(next)}::jsonb WHERE run_id=${input.runId} AND stage=${input.stage} AND ${streamWhere(input.stream)} AND cursor=${expected}::jsonb RETURNING 1 AS changed`,
    );
    if (!changed.length)
      throw new Error("Analytics cursor changed; stale page owner cannot checkpoint");
  });
}
