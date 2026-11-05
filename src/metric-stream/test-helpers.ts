import type { AnalyticsQueryOwner } from "../analytics/analytics-query-owner.ts";
import { analyticsPosition, completedExecResult } from "../analytics/test-helpers.ts";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { buildMetricStreamSinkSchemaStatements } from "../db/clickhouse-metric-stream-bootstrap.ts";
import { setupTestDatabase } from "../db/test-helpers.ts";
import { captureException } from "../lib/error-reporting.ts";
import type { MetricStreamEventV2 } from "./events.ts";

export const sourceEvent: MetricStreamEventV2 = {
  version: 2,
  operationRevision: "4503599627370496",
  id: "10000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000001",
  providerId: "fixture",
  generation: 1,
  recordedAt: "2026-11-03T00:00:00.123456Z",
  sourceType: "sensor",
  channel: "heart_rate",
  scalar: 72,
};
export const sourcePosition = analyticsPosition(
  {
    transport: "pulsar",
    epoch: "epoch-1",
    topic: "persistent://public/default/sensor",
    partition: -1,
  },
  1n,
);
export const sourceIngestedAt = "2026-11-03T01:00:00.123456Z";

export function sourceOwner(queryRows: readonly (readonly object[])[] = []) {
  const requests: Parameters<ClickHouseClient["query"]>[0][] = [];
  const commands: Parameters<ClickHouseClient["command"]>[0][] = [];
  const executions: Parameters<ClickHouseClient["exec"]>[0][] = [];
  const rows: Record<string, unknown>[] = [];
  const client: ClickHouseClient = {
    query: async (request) => {
      const response = queryRows[requests.length];
      requests.push(request);
      if (!response) throw new Error("Unexpected query beyond this unit fixture");
      return { json: async () => JSON.parse(JSON.stringify(response)) };
    },
    command: async (command) => {
      commands.push(command);
    },
    exec: async (execution) => {
      executions.push(execution);
      const before = rows.length;
      if ("values" in execution) {
        let body = "";
        for await (const chunk of execution.values) body += String(chunk);
        for (const line of body.trim().split("\n")) if (line) rows.push(JSON.parse(line));
      }
      return completedExecResult(String(rows.length - before));
    },
    insert: async () => {
      throw new Error("Unexpected insert outside source application");
    },
  };
  const owner: AnalyticsQueryOwner = {
    client,
    ingestedAt: sourceIngestedAt,
    assertActive: async () => undefined,
    reserveIngestionThrough: async () => {
      throw new Error("Unexpected ingestion reservation");
    },
    reuseIngestionReservation: async () => {
      throw new Error("Unexpected reservation reuse outside the coordinator");
    },
  };
  return { owner, requests, commands, executions, rows };
}

import { randomUUID } from "node:crypto";

/** Actual current PG/schema builders; namespace isolation never substitutes journal DDL. */
export async function createMetricStreamAnalyticsTestContext() {
  const postgres = await setupTestDatabase();
  let real: ReturnType<typeof createClickHouseClientFromEnv>;
  try {
    real = createClickHouseClientFromEnv();
  } catch (error) {
    captureException(error, { tags: { source: "metric-stream-fixture-client" } });
    const [cleanup] = await Promise.allSettled([postgres.cleanup()]);
    if (cleanup?.status === "rejected")
      throw new AggregateError(
        [error, cleanup.reason],
        "Metric-stream client setup and PG cleanup failed",
      );
    throw error;
  }
  const memory = { max_memory_usage: String(128 * 1024 * 1024) };
  const prefix = `metric_sink_${randomUUID().replaceAll("-", "")}`;
  const namespaces = { ingest: `${prefix}_ingest`, analytics: `${prefix}_analytics` };
  const rewrite = (query: string) =>
    query
      .replace(
        /\b(ingest|analytics)\./g,
        (_match, role: string) =>
          `${role === "ingest" ? namespaces.ingest : namespaces.analytics}.`,
      )
      .replace(
        /CREATE DATABASE IF NOT EXISTS (ingest|analytics)\b/g,
        (_match, role: string) =>
          `CREATE DATABASE IF NOT EXISTS ${role === "ingest" ? namespaces.ingest : namespaces.analytics}`,
      );
  async function cleanup() {
    const drops = await Promise.allSettled(
      Object.values(namespaces).map((namespace) =>
        real.command({
          query: `DROP DATABASE IF EXISTS ${namespace} SYNC`,
          clickhouse_settings: memory,
        }),
      ),
    );
    const closes = await Promise.allSettled([real.close(), postgres.cleanup()]);
    const errors: unknown[] = [];
    for (const result of [...drops, ...closes])
      if (result.status === "rejected") {
        errors.push(result.reason);
        captureException(result.reason, { tags: { source: "metric-stream-fixture-cleanup" } });
      }
    if (errors.length) throw new AggregateError(errors, "Metric-stream fixture cleanup failed");
  }
  try {
    const insert = real.insert?.bind(real);
    if (!insert) throw new Error("Metric-stream fixture requires an insert-capable client");
    const client: ClickHouseClient & Required<Pick<ClickHouseClient, "insert" | "close">> = {
      command: (options) =>
        real.command({
          ...options,
          query: rewrite(options.query),
          clickhouse_settings: { ...options.clickhouse_settings, ...memory },
        }),
      exec: (options) =>
        real.exec({
          ...options,
          query: rewrite(options.query),
          clickhouse_settings: { ...options.clickhouse_settings, ...memory },
        }),
      query: (options) =>
        real.query({
          ...options,
          query: rewrite(options.query),
          clickhouse_settings: { ...options.clickhouse_settings, ...memory },
        }),
      insert: (options) =>
        insert({
          ...options,
          table: rewrite(options.table),
          clickhouse_settings: { ...options.clickhouse_settings, ...memory },
        }),
      close: () => real.close(),
    };
    for (const namespace of Object.values(namespaces))
      await real.command({ query: `CREATE DATABASE ${namespace}`, clickhouse_settings: memory });
    for (const query of buildMetricStreamSinkSchemaStatements()) await client.command({ query });
    return {
      database: postgres.db,
      client,
      namespaces,
      cleanup,
      stream: {
        transport: "pulsar" as const,
        epoch: randomUUID(),
        topic: `persistent://public/default/fixture-${randomUUID()}`,
        partition: -1,
      },
    };
  } catch (error) {
    captureException(error, { tags: { source: "metric-stream-fixture-setup" } });
    const [result] = await Promise.allSettled([cleanup()]);
    if (result?.status === "rejected")
      throw new AggregateError(
        [error, result.reason],
        "Metric-stream fixture setup and cleanup failed",
      );
    throw error;
  }
}
