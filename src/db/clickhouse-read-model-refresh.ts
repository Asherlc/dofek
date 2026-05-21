import type { ClickHouseCommandClient } from "./clickhouse.ts";

export async function refreshBodyMeasurementReadModel(
  client: ClickHouseCommandClient,
): Promise<void> {
  await client.command({ query: "SYSTEM REFRESH VIEW analytics.v_body_measurement" });
  await client.command({ query: "SYSTEM WAIT VIEW analytics.v_body_measurement" });
}
