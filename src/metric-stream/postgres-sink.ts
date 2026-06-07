import type { SQLWrapper } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { createDatabaseFromEnv } from "../db/index.ts";
import {
  isMetricStreamDeletedEvent,
  type MetricStreamDeleteScope,
  type MetricStreamEventV1,
  type MetricStreamRedpandaEvent,
} from "./events.ts";
import {
  createKafkaMetricStreamConsumerFromEnv,
  runMetricStreamEventConsumer,
} from "./redpanda-consumer.ts";

export interface PostgresMetricStreamSinkDatabase {
  execute(query: SQLWrapper | string): Promise<unknown[]>;
}

function geometryValueSql(event: MetricStreamEventV1): SQLWrapper {
  if (event.point === null || event.point === undefined) {
    return sql`NULL`;
  }
  return sql`ST_GeomFromEWKT(${event.point})`;
}

function jsonValueSql(value: MetricStreamEventV1["metadata"]): SQLWrapper {
  if (value === null || value === undefined) {
    return sql`NULL`;
  }
  return sql`${JSON.stringify(value)}::jsonb`;
}

function vectorValueSql(value: MetricStreamEventV1["vector"]): SQLWrapper {
  if (value === null || value === undefined) {
    return sql`NULL`;
  }
  return sql`ARRAY[${sql.join(
    value.map((item) => sql`${item}::real`),
    sql`, `,
  )}]`;
}

function nullableUuidValueSql(value: string | null | undefined): SQLWrapper {
  if (value === null || value === undefined) {
    return sql`NULL`;
  }
  return sql`${value}::uuid`;
}

function metricStreamEventPostgresValues(event: MetricStreamEventV1): SQLWrapper {
  return sql`(
    ${event.id}::uuid,
    ${event.recordedAt}::timestamptz,
    ${event.userId}::uuid,
    ${event.providerId},
    ${event.externalId},
    ${event.deviceId},
    ${event.sourceType},
    ${event.channel},
    ${nullableUuidValueSql(event.activityId)},
    ${event.scalar},
    ${vectorValueSql(event.vector)},
    ${geometryValueSql(event)},
    ${jsonValueSql(event.metadata)}
  )`;
}

export async function insertMetricStreamEventsIntoPostgres(
  db: PostgresMetricStreamSinkDatabase,
  events: readonly MetricStreamEventV1[],
): Promise<number> {
  if (events.length === 0) {
    return 0;
  }

  await db.execute(
    sql`INSERT INTO fitness.metric_stream (
      id,
      recorded_at,
      user_id,
      provider_id,
      external_id,
      device_id,
      source_type,
      channel,
      activity_id,
      scalar,
      vector,
      point,
      metadata
    )
    VALUES ${sql.join(events.map(metricStreamEventPostgresValues), sql`, `)}
    ON CONFLICT (id, recorded_at) DO UPDATE
      SET scalar = EXCLUDED.scalar,
          vector = EXCLUDED.vector,
          point = EXCLUDED.point,
          metadata = EXCLUDED.metadata,
          device_id = EXCLUDED.device_id,
          source_type = EXCLUDED.source_type,
          activity_id = EXCLUDED.activity_id`,
  );

  return events.length;
}

function deleteScopeConditions(scope: MetricStreamDeleteScope): SQLWrapper[] {
  const conditions: SQLWrapper[] = [];
  if (scope.userId) conditions.push(sql`user_id = ${scope.userId}::uuid`);
  if (scope.providerId) conditions.push(sql`provider_id = ${scope.providerId}`);
  if (scope.externalId !== undefined) conditions.push(sql`external_id = ${scope.externalId}`);
  if (scope.channel) conditions.push(sql`channel = ${scope.channel}`);
  if (scope.activityId) conditions.push(sql`activity_id = ${scope.activityId}::uuid`);
  if (scope.recordedAtStart) {
    conditions.push(sql`recorded_at >= ${scope.recordedAtStart}::timestamptz`);
  }
  if (scope.recordedAtEnd) {
    conditions.push(sql`recorded_at < ${scope.recordedAtEnd}::timestamptz`);
  }
  if (conditions.length === 0) {
    throw new Error("Metric stream delete scope produced no Postgres conditions");
  }
  return conditions;
}

export async function deleteMetricStreamScopeFromPostgres(
  db: PostgresMetricStreamSinkDatabase,
  scope: MetricStreamDeleteScope,
): Promise<void> {
  await db.execute(
    sql`DELETE FROM fitness.metric_stream WHERE ${sql.join(deleteScopeConditions(scope), sql` AND `)}`,
  );
}

export async function applyMetricStreamEventsToPostgres(
  db: PostgresMetricStreamSinkDatabase,
  events: readonly MetricStreamRedpandaEvent[],
): Promise<number> {
  let inserted = 0;
  let rowBuffer: MetricStreamEventV1[] = [];
  const flushRows = async () => {
    if (rowBuffer.length === 0) return;
    inserted += await insertMetricStreamEventsIntoPostgres(db, rowBuffer);
    rowBuffer = [];
  };

  for (const event of events) {
    if (isMetricStreamDeletedEvent(event)) {
      await flushRows();
      await deleteMetricStreamScopeFromPostgres(db, event.scope);
      continue;
    }
    rowBuffer.push(event);
  }

  await flushRows();
  return inserted;
}

export async function runMetricStreamPostgresSinkFromEnv(): Promise<void> {
  const db = createDatabaseFromEnv();
  const { consumer, topic } = createKafkaMetricStreamConsumerFromEnv("metric-stream-postgres-sink");

  await runMetricStreamEventConsumer({
    consumer,
    topic,
    handleEvents: async (events) => {
      await applyMetricStreamEventsToPostgres(db, events);
    },
  });
}
