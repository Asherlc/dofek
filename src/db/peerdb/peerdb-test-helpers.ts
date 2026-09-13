import type { ClickHouseClient } from "../clickhouse.ts";
import type { PeerDbMirrorApiClient, PeerDbMirrorStatus } from "../clickhouse-cdc.ts";

const peerDbPollIntervalMs = 1_000;
const peerDbTestTimeoutMs = 180_000;

export async function waitForPeerDbApi(client: PeerDbMirrorApiClient): Promise<void> {
  const deadline = Date.now() + peerDbTestTimeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await client.listMirrors();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, peerDbPollIntervalMs));
    }
  }
  throw new Error("Timed out waiting for the PeerDB API", { cause: lastError });
}

export async function waitForCanonicalMirror(
  client: PeerDbMirrorApiClient,
  mirrorName: string,
  expectedMappings: PeerDbMirrorStatus["tableMappings"],
): Promise<PeerDbMirrorStatus> {
  const deadline = Date.now() + peerDbTestTimeoutMs;
  while (Date.now() < deadline) {
    const status = await client.getMirrorStatus(mirrorName);
    const actualMappings = status.tableMappings.map(normalizeMapping).sort();
    const desiredMappings = expectedMappings.map(normalizeMapping).sort();
    if (
      status.currentFlowState === "STATUS_RUNNING" &&
      JSON.stringify(actualMappings) === JSON.stringify(desiredMappings)
    ) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, peerDbPollIntervalMs));
  }
  throw new Error(`Timed out waiting for canonical PeerDB mirror ${mirrorName}`);
}

export async function waitForClickHouseFixture(
  client: ClickHouseClient,
  expectedIds: { activity: string; dailyMetrics: string; sleepSession: string },
): Promise<void> {
  const deadline = Date.now() + peerDbTestTimeoutMs;
  while (Date.now() < deadline) {
    const [activityCount, dailyMetricsCount, sleepSessionCount] = await Promise.all([
      countRows(client, "activity", expectedIds.activity),
      countRows(client, "daily_metrics", expectedIds.dailyMetrics),
      countRows(client, "sleep_session", expectedIds.sleepSession),
    ]);
    if (activityCount === 1 && dailyMetricsCount === 1 && sleepSessionCount === 1) return;
    await new Promise((resolve) => setTimeout(resolve, peerDbPollIntervalMs));
  }
  throw new Error("Timed out waiting for the PeerDB CDC fixture in ClickHouse");
}

function normalizeMapping(mapping: PeerDbMirrorStatus["tableMappings"][number]): string {
  return [
    mapping.sourceTableIdentifier,
    mapping.destinationTableIdentifier,
    [...mapping.exclude].sort().join(","),
  ].join("|");
}

async function countRows(client: ClickHouseClient, table: string, id: string): Promise<number> {
  const result = await client.query<{ row_count: number | string }>({
    query: `SELECT count() AS row_count FROM postgres_fitness.${table} FINAL WHERE id = {id:UUID}`,
    query_params: { id },
    format: "JSONEachRow",
  });
  const rows = await result.json();
  return Number(rows[0]?.row_count ?? 0);
}
