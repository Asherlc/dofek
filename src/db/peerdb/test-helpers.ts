import { z } from "zod";
import type { ClickHouseClient } from "../clickhouse.ts";
import type { PeerDbMirrorApiClient, PeerDbMirrorStatus } from "../clickhouse-cdc.ts";

const peerDbPollIntervalMs = 1_000;
const peerDbTestTimeoutMs = 180_000;
const clickHouseCountSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/).transform(Number),
]);
const clickHouseCountRowsSchema = z.tuple([z.object({ row_count: clickHouseCountSchema })]);

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

export interface ClickHouseFixtureRow {
  predicate: string;
  queryParams: Record<string, unknown>;
  table: string;
}

export async function waitForClickHouseRows(
  client: ClickHouseClient,
  expectedRows: readonly ClickHouseFixtureRow[],
): Promise<void> {
  const deadline = Date.now() + peerDbTestTimeoutMs;
  while (Date.now() < deadline) {
    const counts = await Promise.all(
      expectedRows.map(({ predicate, queryParams, table }) =>
        countMatchingRows(client, table, predicate, queryParams),
      ),
    );
    if (counts.every((count) => count === 1)) return;
    await new Promise((resolve) => setTimeout(resolve, peerDbPollIntervalMs));
  }
  throw new Error("Timed out waiting for every managed PeerDB table fixture in ClickHouse");
}

function normalizeMapping(mapping: PeerDbMirrorStatus["tableMappings"][number]): string {
  return [
    mapping.sourceTableIdentifier,
    mapping.destinationTableIdentifier,
    [...mapping.exclude].sort().join(","),
  ].join("|");
}

async function countRows(client: ClickHouseClient, table: string, id: string): Promise<number> {
  return countMatchingRows(client, table, "id = {id:UUID}", { id });
}

async function countMatchingRows(
  client: ClickHouseClient,
  table: string,
  predicate: string,
  queryParams: Record<string, unknown>,
): Promise<number> {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`Invalid ClickHouse table identifier: ${table}`);
  const result = await client.query<{ row_count: number | string }>({
    query: `SELECT count() AS row_count FROM postgres_fitness.${table} FINAL WHERE ${predicate}`,
    query_params: queryParams,
    format: "JSONEachRow",
  });
  const [row] = clickHouseCountRowsSchema.parse(await result.json());
  return row.row_count;
}
