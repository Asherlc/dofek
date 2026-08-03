import {
  buildAccountErasureFenceTableSql,
  buildAccountErasureOperationFenceTableSql,
} from "../../metric-stream/clickhouse-table.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0069_account_erasure_fence",
    statements: [buildAccountErasureFenceTableSql(), buildAccountErasureOperationFenceTableSql()],
  };
}
