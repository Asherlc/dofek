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
  type AnalyticsDeliveryGroup,
  analyticsDeliveryGroupIngestionTimes,
  analyticsDeliveryGroupIntentId,
  describeAnalyticsDeliveryGroup,
  type PersistedAnalyticsDeliveryGroup,
} from "./analytics-delivery-group.ts";
import { verifyAnalyticsDeliveryReceipts } from "./effect-journal-group.ts";
import {
  type AnalyticsStream,
  assertPositionStream,
  metricStreamPositionIdentity,
} from "./journal-position.ts";

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

const changedSchema = z.object({ changed: z.number() });

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
