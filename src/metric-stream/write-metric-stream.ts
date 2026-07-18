import { getProviderDataGeneration } from "../db/provider-data-deletion.ts";
import type { Database } from "../db/typed-sql.ts";
import type { MetricStreamEventV1, MetricStreamRowInput } from "./events.ts";
import type { MetricStreamEventPublisher } from "./redpanda-producer.ts";

export interface WriteMetricStreamRowsOptions {
  database: Database;
  publisher: MetricStreamEventPublisher;
  rows: readonly MetricStreamRowInput[];
}

export interface WriteMetricStreamRowsResult {
  events: MetricStreamEventV1[];
  published: number;
}

export async function addProviderDataGenerations(
  database: Database,
  rows: readonly MetricStreamRowInput[],
): Promise<MetricStreamRowInput[]> {
  const generationsByProvider = new Map<string, number>();
  for (const row of rows) {
    const providerKey = `${row.userId}\0${row.providerId}`;
    if (!generationsByProvider.has(providerKey)) {
      generationsByProvider.set(
        providerKey,
        await getProviderDataGeneration(database, row.userId, row.providerId),
      );
    }
  }
  return rows.map((row) => {
    const generation = generationsByProvider.get(`${row.userId}\0${row.providerId}`);
    if (generation === undefined) {
      throw new Error("Provider data generation was not resolved");
    }
    return { ...row, generation };
  });
}

export async function writeMetricStreamRows(
  options: WriteMetricStreamRowsOptions,
): Promise<WriteMetricStreamRowsResult> {
  const rowsWithGeneration = await addProviderDataGenerations(options.database, options.rows);
  const events = await options.publisher.publishRows(rowsWithGeneration);
  return {
    events,
    published: events.length,
  };
}
