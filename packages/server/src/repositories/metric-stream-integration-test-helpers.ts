export interface MetricStreamSeedRow {
  id: string;
  recorded_at: string;
  provider_id: string;
  channel: string;
  scalar: number;
  is_deleted: 0 | 1;
  ingested_at?: string;
  version: number;
}

interface MetricStreamSeedClient {
  insert?: (args: {
    table: string;
    format: "JSONEachRow";
    values: Record<string, unknown>[];
  }) => Promise<unknown>;
}

export async function seedMetricStreamRows(
  client: MetricStreamSeedClient,
  userId: string,
  rows: MetricStreamSeedRow[],
): Promise<void> {
  await client.insert?.({
    table: "ingest.metric_stream",
    format: "JSONEachRow",
    values: rows.map((row) => ({
      id: row.id,
      user_id: userId,
      recorded_at: row.recorded_at,
      provider_id: row.provider_id,
      channel: row.channel,
      scalar: row.scalar,
      is_deleted: row.is_deleted,
      ingested_at: row.ingested_at ?? "2026-04-12 00:00:00.000",
      version: row.version,
    })),
  });
}
