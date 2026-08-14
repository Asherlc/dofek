import { AsyncLocalStorage } from "node:async_hooks";
import type { SchemaExecutionDatabase } from "../db/typed-sql.ts";

const metricStreamWriteDatabase = new AsyncLocalStorage<SchemaExecutionDatabase>();

export function currentMetricStreamWriteDatabase(): SchemaExecutionDatabase | null {
  return metricStreamWriteDatabase.getStore() ?? null;
}

export function runWithMetricStreamWriteDatabase<T>(
  database: SchemaExecutionDatabase,
  work: () => Promise<T>,
): Promise<T> {
  return metricStreamWriteDatabase.run(database, work);
}
