import {
  buildProviderDataGenerationTableSql,
  METRIC_STREAM_PROVIDER_GENERATION_ORDER_BY,
  METRIC_STREAM_PROVIDER_GENERATION_PROJECTION,
  METRIC_STREAM_TABLE,
} from "../../metric-stream/clickhouse-table.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0046_provider_data_generation",
    statements: [
      `ALTER TABLE ${METRIC_STREAM_TABLE}
        ADD COLUMN IF NOT EXISTS generation UInt64 DEFAULT 0`,
      `ALTER TABLE ${METRIC_STREAM_TABLE}
        MODIFY SETTING deduplicate_merge_projection_mode = 'rebuild'`,
      `ALTER TABLE ${METRIC_STREAM_TABLE}
        ADD PROJECTION IF NOT EXISTS ${METRIC_STREAM_PROVIDER_GENERATION_PROJECTION} (
          SELECT user_id, provider_id, generation, id, _part_offset
          ORDER BY ${METRIC_STREAM_PROVIDER_GENERATION_ORDER_BY}
        )`,
      buildProviderDataGenerationTableSql(),
    ],
  };
}
