import { getProviderDataGenerations } from "../db/provider-data-deletion.ts";
import type { Database } from "../db/typed-sql.ts";
import type { MetricStreamEventV2, MetricStreamRowInput } from "./events.ts";
import type { MetricStreamEventPublisher } from "./redpanda-producer.ts";

export interface WriteMetricStreamRowsOptions {
  database: Database;
  publisher: MetricStreamEventPublisher;
  rows: readonly MetricStreamRowInput[];
}

export interface WriteMetricStreamRowsResult {
  events: MetricStreamEventV2[];
  published: number;
}

export interface PreparedMetricStreamRows {
  operationRevision: string;
  rows: MetricStreamRowInput[];
}

export async function prepareMetricStreamRows(
  database: Database,
  rows: readonly MetricStreamRowInput[],
): Promise<PreparedMetricStreamRows> {
  const scopesByProvider = new Map<string, { providerId: string; userId: string }>();
  for (const row of rows) {
    const providerKey = `${row.userId}\0${row.providerId}`;
    scopesByProvider.set(providerKey, { providerId: row.providerId, userId: row.userId });
  }
  const context = await getProviderDataGenerations(database, [...scopesByProvider.values()]);
  const generationsByProvider = new Map<string, number>();
  for (const generation of context.generations) {
    generationsByProvider.set(
      `${generation.userId}\0${generation.providerId}`,
      generation.generation,
    );
  }
  return {
    operationRevision: context.operationRevision,
    rows: rows.map((row) => {
      const generation = generationsByProvider.get(`${row.userId}\0${row.providerId}`);
      if (generation === undefined) {
        throw new Error("Provider data generation was not resolved");
      }
      return { ...row, generation };
    }),
  };
}

export async function writeMetricStreamRows(
  options: WriteMetricStreamRowsOptions,
): Promise<WriteMetricStreamRowsResult> {
  if (options.rows.length === 0) {
    return { events: [], published: 0 };
  }
  const prepared = await prepareMetricStreamRows(options.database, options.rows);
  const events = await options.publisher.publishRows(prepared.rows, {
    operationRevision: prepared.operationRevision,
  });
  return {
    events,
    published: events.length,
  };
}
