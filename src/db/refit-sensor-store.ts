import type { z } from "zod";
import type { RefitSensorStore } from "../personalization/refit.ts";

/** Subset of the ClickHouse client interface we use here. */
interface QueryClient {
  query(args: {
    query: string;
    format: "JSONEachRow";
    query_params?: Record<string, unknown>;
  }): Promise<{ json: () => Promise<unknown[]> }>;
}

/**
 * Minimal ClickHouse-backed RefitSensorStore for the BullMQ post-sync worker.
 * Mirrors the query() method of ClickHouseActivitySensorStore (which lives in
 * packages/server) without pulling that whole package into src/jobs.
 */
export function createRefitSensorStore(client: QueryClient): RefitSensorStore {
  return {
    async query<TSchema extends z.ZodType>(
      schema: TSchema,
      query: string,
      params: Record<string, unknown> = {},
    ): Promise<z.infer<TSchema>[]> {
      const result = await client.query({
        query,
        format: "JSONEachRow",
        query_params: params,
      });
      const rows = await result.json();
      return rows.map((row) => schema.parse(row));
    },
  };
}
