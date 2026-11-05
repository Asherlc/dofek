import { dirname, resolve } from "node:path";
import { BoundedSensorFixture } from "../db/bounded-sensor-test-helpers.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { createAccountErasureWorkLockPool } from "../jobs/account-erasure-work-guard.ts";
import {
  buildMetricStreamDeleteAcknowledgementTableSql,
  providerDeletionAcknowledgementUpgradeStatements,
} from "../metric-stream/clickhouse-table.ts";
import { runBoundedAnalyticsPage } from "./bounded-analytics.ts";

export class BoundedExecutorFixture extends BoundedSensorFixture {
  #guards: ReturnType<typeof createAccountErasureWorkLockPool> | undefined;
  readonly boundaries: string[] = [];
  readonly ownedQueryIds: string[] = [];
  readonly ownedClient: ClickHouseClient = {
    command: async (options) => {
      if (options.query_id) this.ownedQueryIds.push(options.query_id);
      const result = await this.client.command({ ...options, query: this.scope(options.query) });
      this.boundaries.push(options.query.startsWith("INSERT INTO") ? "output" : "command");
      return result;
    },
    query: async <T extends object>(options: Parameters<ClickHouseClient["query"]>[0]) => {
      if (options.query_id) this.ownedQueryIds.push(options.query_id);
      const result = await this.client.query({ ...options, query: this.scope(options.query) });
      const rows = await result.json<T>();
      return { json: async () => rows };
    },
    insert: async (options) => {
      if (options.query_id) this.ownedQueryIds.push(options.query_id);
      await this.client.insert({
        ...options,
        values: [...options.values],
        table: this.scope(options.table),
      });
      this.boundaries.push(options.table);
    },
  };
  async execute(clickhouse: ClickHouseClient = this.ownedClient) {
    const { database, runId, stream } = this.work;
    if (!this.#guards) throw new Error("Create the executor fixture before running a page");
    return runBoundedAnalyticsPage(
      { database, clickhouse, guards: this.#guards },
      {
        runId,
        stream,
        stage: "scalar",
        pageSize: 20,
        artifactDirectory: dirname(this.evidencePath),
      },
    );
  }
  failAfterOutputClient(): ClickHouseClient {
    let fail = true;
    return {
      ...this.ownedClient,
      query: async <T extends object>(options: Parameters<ClickHouseClient["query"]>[0]) => {
        if (fail && this.boundaries.includes("output")) {
          fail = false;
          try {
            await this.client.command({
              query: "SELECT throwIf(1,'after output fixture')",
              query_id: options.query_id,
              clickhouse_settings: { log_queries: 1 },
            });
          } finally {
            // Explicit fixture operation; runtime ownership never flushes logs.
            await this.client.command({ query: "SYSTEM FLUSH LOGS" });
          }
        }
        return this.ownedClient.query<T>(options);
      },
    };
  }
  async enablePhysicalErasureFixture(): Promise<void> {
    const tables = await this.read(
      `SELECT name FROM system.tables WHERE database='${this.database}' AND endsWith(engine,'MergeTree')`,
    );
    for (const table of tables)
      await this.command(
        `ALTER TABLE \`${this.database}\`.\`${String(table.name)}\` MODIFY SETTING old_parts_lifetime=1,cleanup_delay_period=1,cleanup_delay_period_random_add=0,max_cleanup_delay_period=1`,
      );
  }
  async create(): Promise<void> {
    await super.create();
    this.#guards = createAccountErasureWorkLockPool(this.work.connectionString);
    await this.command(buildMetricStreamDeleteAcknowledgementTableSql());
    for (const statement of providerDeletionAcknowledgementUpgradeStatements())
      await this.command(statement);
    process.env.PATH = `${resolve(".venv-analytics/bin")}:${process.env.PATH ?? ""}`;
    process.env.DBT_TARGET = "dev";
    process.env.DBT_CLICKHOUSE_SCHEMA = this.database;
    process.env.DBT_ANALYTICS_SOURCE_SCHEMA = this.database;
    process.env.DBT_INGEST_SOURCE_SCHEMA = this.database;
    process.env.DBT_POSTGRES_FITNESS_SOURCE_SCHEMA = this.database;
  }
  async close(): Promise<void> {
    try {
      await this.#guards?.close();
    } finally {
      await super.close();
    }
  }
}
