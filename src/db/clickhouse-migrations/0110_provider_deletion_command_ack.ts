import { providerDeletionAcknowledgementUpgradeStatements } from "../../metric-stream/clickhouse-table.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0110_provider_deletion_command_ack",
    phase: "pre-cdc",
    statements: providerDeletionAcknowledgementUpgradeStatements(),
  };
}
