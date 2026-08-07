import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type ClickHouseClient = ReturnType<typeof createClient>;

interface SampleRateRow {
  interval_seconds: number;
}

describe("activity_sensor_summary_rows power sample rate", () => {
  let client: ClickHouseClient | undefined;

  beforeAll(async () => {
    client = createClient({
      url: requireClickHouseUrl(),
      request_timeout: 30_000,
    });
    await waitForClickHouse(client);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it("does not evaluate single-sample power groups as infinite sample rates", async () => {
    const result = await requireClient(client).query({
      query: `
        WITH power_cumulative AS (
          SELECT
            toUUID('00000000-0000-0000-0000-000000000001') AS activity_id,
            parseDateTime64BestEffort('2026-07-01T15:00:00.000Z', 6, 'UTC') AS recorded_at
        )
        SELECT
          greatest(toInt32(round(
            dateDiff('second', min(recorded_at), max(recorded_at))
            / greatest(count() - 1, 1)
          )), 1) AS interval_seconds
        FROM power_cumulative
        GROUP BY activity_id
        HAVING count() > 1
      `,
      format: "JSONEachRow",
    });

    expect(await result.json<SampleRateRow>()).toEqual([]);
  });
});

function requireClickHouseUrl(): string {
  const url = process.env.CLICKHOUSE_URL?.trim();
  if (!url) {
    throw new Error("CLICKHOUSE_URL is required for activity sensor summary integration tests");
  }
  return url;
}

function requireClient(client: ClickHouseClient | undefined): ClickHouseClient {
  if (!client) {
    throw new Error("ClickHouse client was not initialized");
  }
  return client;
}

async function waitForClickHouse(client: ClickHouseClient): Promise<void> {
  let lastError: unknown;
  for (let attemptIndex = 0; attemptIndex < 30; attemptIndex += 1) {
    try {
      await client.query({ query: "SELECT 1", format: "JSONEachRow" });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveAfterDelay) => setTimeout(resolveAfterDelay, 1_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("ClickHouse did not become ready");
}
