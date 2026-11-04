export function kafkaTestPositions(
  offsets: readonly string[],
  topic = "metric-stream-v1",
  partition = 2,
) {
  return offsets.map((offset) => ({
    transport: "kafka" as const,
    epoch: "test-epoch",
    topic,
    partition,
    offset,
  }));
}

/** Isolated current schemas, never historical production backfill migrations. */
export async function createMetricStreamAnalyticsTestContext() {
  const { createAnalyticsTestContext } = await import("../analytics/test-helpers.ts");
  const tables = await import("./clickhouse-table.ts");
  const context = await createAnalyticsTestContext();
  const rewrite = (value: string) => value.replaceAll("ingest.", "analytics.");
  const insert = context.clickhouse.insert?.bind(context.clickhouse);
  if (!insert) throw new Error("Fixture requires insert");
  const client: import("../db/clickhouse.ts").ClickHouseClient = {
    command: (options) => context.clickhouse.command({ ...options, query: rewrite(options.query) }),
    query: (options) => context.clickhouse.query({ ...options, query: rewrite(options.query) }),
    insert: (options) => insert({ ...options, table: rewrite(options.table) }),
  };
  for (const query of [
    tables.buildIngestMetricStreamCreateTableSql(),
    tables.buildAccountErasureFenceTableSql(),
    tables.buildAccountErasureOperationFenceTableSql(),
    tables.buildMetricStreamDeleteAcknowledgementTableSql(),
    tables.buildMetricStreamDeleteScopeTableSql(),
    tables.buildMetricStreamProcessingAcknowledgementTableSql(),
    tables.buildProviderDataGenerationTableSql(),
    tables.buildMetricStreamSourcePlacementIngestSql(),
  ])
    await client.command({ query });
  return { ...context, client };
}
