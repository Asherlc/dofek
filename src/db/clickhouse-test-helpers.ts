import type { ClickHouseClient } from "@clickhouse/client";

export async function unexpectedClickHouseExec(
  _options: Parameters<ClickHouseClient["exec"]>[0],
): Promise<never> {
  throw new Error("Unexpected ClickHouse streaming execution in this fixture");
}
