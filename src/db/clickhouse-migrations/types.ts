import type { ClickHouseCommandClient } from "../clickhouse.ts";

export interface ClickHouseMigration {
  id: string;
  phase?: "pre-cdc";
  requiresPreviouslyAppliedMigrationId?: string;
  statements: string[];
  run?: (client: ClickHouseCommandClient, postgresConnectionString: string) => Promise<void>;
}

export type ClickHouseMigrationFactory = (postgresConnectionString: string) => ClickHouseMigration;
