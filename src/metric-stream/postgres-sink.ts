import type { SQLWrapper } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { createDatabaseFromEnv } from "../db/index.ts";
import { type MetricStreamEventV1, metricStreamEventV1Schema } from "./events.ts";
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
  return sql`ST_GeomFromGeoJSON(${event.point})`;
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
  const parsedEvents = events.map((event) => metricStreamEventV1Schema.parse(event));
  if (parsedEvents.length === 0) {
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
    VALUES ${sql.join(parsedEvents.map(metricStreamEventPostgresValues), sql`, `)}
    ON CONFLICT (user_id, provider_id, external_id, channel, recorded_at) DO UPDATE
      SET scalar = EXCLUDED.scalar,
          vector = EXCLUDED.vector,
          point = EXCLUDED.point,
          metadata = EXCLUDED.metadata,
          device_id = EXCLUDED.device_id,
          source_type = EXCLUDED.source_type,
          activity_id = EXCLUDED.activity_id`,
  );

  return parsedEvents.length;
}

export async function runMetricStreamPostgresSinkFromEnv(): Promise<void> {
  const db = createDatabaseFromEnv();
  const { consumer, topic } = createKafkaMetricStreamConsumerFromEnv("metric-stream-postgres-sink");

  await runMetricStreamEventConsumer({
    consumer,
    topic,
    handleEvents: async (events) => {
      await insertMetricStreamEventsIntoPostgres(db, events);
    },
  });
}
