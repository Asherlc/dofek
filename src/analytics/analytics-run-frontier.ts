import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, type SchemaExecutionDatabase } from "../db/typed-sql.ts";
import {
  compareMetricStreamPositions,
  type MetricStreamPosition,
  metricStreamPositionSchema,
} from "../metric-stream/transport-position.ts";
import { type AnalyticsStream, assertPositionStream } from "./journal-position.ts";

export async function loadAnalyticsRunFrontier(
  database: SchemaExecutionDatabase,
  input: { runId: string; stream: AnalyticsStream },
): Promise<MetricStreamPosition> {
  const rows = await executeWithSchema(
    database,
    z.object({ position: metricStreamPositionSchema }),
    sql`SELECT frontier.position FROM fitness.analytics_required_frontier AS frontier JOIN fitness.analytics_run AS run ON run.id=frontier.run_id WHERE run.id=${input.runId} AND run.sealed AND frontier.transport=${input.stream.transport} AND frontier.epoch=${input.stream.epoch} AND frontier.topic=${input.stream.topic} AND frontier.partition=${input.stream.partition}`,
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
