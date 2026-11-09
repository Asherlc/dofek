import { z } from "zod";
import { clickHouseAccountErasurePredicates } from "./clickhouse-erasure.ts";
import {
  columnTypes,
  inspectClickHouseAccountErasureCoverage,
  qualifiedTable,
} from "./clickhouse-erasure-coverage.ts";
import type { AccountErasureIdentifierStore } from "./identifier-store.ts";

const countRowsSchema = z.tuple([z.object({ count: z.coerce.number().int().nonnegative() })]);
export interface PeerDbVerificationClickHouseClient {
  query(options: {
    clickhouse_settings?: Record<string, string | number | boolean>;
    format: "JSONEachRow";
    query: string;
    query_params?: Record<string, unknown>;
  }): Promise<{ json(): Promise<unknown> }>;
}

export interface PeerDbErasureIdentifiers {
  userId: string;
  store: Pick<
    AccountErasureIdentifierStore,
    "readPage" | "assertClosureComplete" | "loadPhysicalProgress"
  >;
}

export async function assertNoActivePeerDbMirroredAccountRows(
  client: PeerDbVerificationClickHouseClient,
  identifiers: PeerDbErasureIdentifiers,
): Promise<void> {
  await identifiers.store.assertClosureComplete("initial");
  if (!(await identifiers.store.loadPhysicalProgress("initial")))
    throw new Error("Account erasure physical preparation is incomplete");
  const tables = await inspectClickHouseAccountErasureCoverage(client, {
    managedDatabases: ["postgres_fitness"],
  });
  for (const table of tables) {
    if (!columnTypes(table).has("_peerdb_is_deleted")) continue;
    for await (const predicate of clickHouseAccountErasurePredicates(
      table,
      identifiers.userId,
      identifiers.store,
    )) {
      const result = await client.query({
        query: `SELECT count() AS count FROM ${qualifiedTable(table.database, table.name)} FINAL
        WHERE _peerdb_is_deleted=0 AND (${predicate.sql})`,
        query_params: predicate.queryParameters,
        clickhouse_settings: { log_queries: 0 },
        format: "JSONEachRow",
      });
      const [row] = countRowsSchema.parse(await result.json());
      if (row.count !== 0)
        throw new Error(
          `PeerDB still exposes active account rows in postgres_fitness.${table.name}`,
        );
    }
  }
}
