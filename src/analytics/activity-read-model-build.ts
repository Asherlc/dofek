import { type SpawnOptions, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE } from "../metric-stream/clickhouse-table.ts";

export const ACTIVITY_DELETE_DBT_SELECT = "activity_source_records+";

export interface SpawnedProcess {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number | null) => void): this;
  emit(event: "error", error: Error): boolean;
  emit(event: "close", code: number | null): boolean;
}

export type ActivityReadModelSpawner = (
  command: string,
  args: readonly string[],
  options: Pick<SpawnOptions, "env" | "stdio">,
) => SpawnedProcess;

function defaultActivityReadModelSpawner(
  command: string,
  args: readonly string[],
  options: Pick<SpawnOptions, "env" | "stdio">,
): SpawnedProcess {
  return spawn(command, [...args], options);
}

export interface WaitForPeerDbActivityDeletesOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

const metricStreamDeleteAcknowledgementCountRowsSchema = z.array(
  z.object({ acknowledgement_count: z.coerce.number().int().nonnegative() }),
);

export async function countActivePeerDbActivities(
  client: ClickHouseClient,
  activityIds: string[],
): Promise<number> {
  if (activityIds.length === 0) return 0;

  const rows = await client.query<{ active_count: string | number }>({
    query: `SELECT count() AS active_count
      FROM postgres_fitness.activity FINAL
      WHERE toString(id) IN {activityIds:Array(String)}
        AND _peerdb_is_deleted = 0
        AND provider_absent_at IS NULL
        AND deleted_at IS NULL`,
    format: "JSONEachRow",
    query_params: { activityIds },
  });
  const row = (await rows.json())[0];
  return Number(row?.active_count ?? 0);
}

export async function countProviderAbsentPeerDbActivities(
  client: ClickHouseClient,
  activityIds: string[],
): Promise<number> {
  if (activityIds.length === 0) return 0;

  const rows = await client.query<{ absent_count: string | number }>({
    query: `SELECT count() AS absent_count
      FROM postgres_fitness.activity FINAL
      WHERE toString(id) IN {activityIds:Array(String)}
        AND _peerdb_is_deleted = 0
        AND provider_absent_at IS NOT NULL`,
    format: "JSONEachRow",
    query_params: { activityIds },
  });
  const row = (await rows.json())[0];
  return Number(row?.absent_count ?? 0);
}

export async function waitForPeerDbActivityDeletes(
  client: ClickHouseClient,
  activityIds: string[],
  options: WaitForPeerDbActivityDeletesOptions = {},
): Promise<void> {
  const uniqueActivityIds = [...new Set(activityIds)];
  if (uniqueActivityIds.length === 0) return;

  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const activeCount = await countActivePeerDbActivities(client, uniqueActivityIds);
    if (activeCount === 0) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Timed out waiting for PeerDB to reflect deletion of ${uniqueActivityIds.length} activities`,
  );
}

export async function waitForPeerDbActivityRestores(
  client: ClickHouseClient,
  activityIds: string[],
  options: WaitForPeerDbActivityDeletesOptions = {},
): Promise<void> {
  const uniqueActivityIds = [...new Set(activityIds)];
  if (uniqueActivityIds.length === 0) return;

  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const absentCount = await countProviderAbsentPeerDbActivities(client, uniqueActivityIds);
    if (absentCount === 0) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Timed out waiting for PeerDB to reflect restoration of ${uniqueActivityIds.length} activities`,
  );
}

async function countMetricStreamDeleteAcknowledgements(
  client: ClickHouseClient,
  eventId: string,
): Promise<number> {
  const result = await client.query({
    query: `SELECT count() AS acknowledgement_count
      FROM ${METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE}
      WHERE event_id = {eventId:UUID}`,
    format: "JSONEachRow",
    query_params: { eventId },
  });
  const rows = metricStreamDeleteAcknowledgementCountRowsSchema.parse(await result.json());
  return rows[0]?.acknowledgement_count ?? 0;
}

export async function waitForMetricStreamDeleteAcknowledgement(
  client: ClickHouseClient,
  eventId: string,
  options: WaitForPeerDbActivityDeletesOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const acknowledgementCount = await countMetricStreamDeleteAcknowledgements(client, eventId);
    if (acknowledgementCount > 0) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Timed out waiting for ClickHouse to acknowledge metric-stream deletion event ${eventId}`,
  );
}

export async function countActivePeerDbProviderRows(
  client: ClickHouseClient,
  userId: string,
  providerId: string,
): Promise<number> {
  const rows = await client.query<{ active_count: string | number }>({
    query: `SELECT sum(active_count) AS active_count
      FROM (
        SELECT count() AS active_count FROM postgres_fitness.activity FINAL
          WHERE user_id = {userId:UUID} AND provider_id = {providerId:String} AND _peerdb_is_deleted = 0
        UNION ALL
        SELECT count() AS active_count FROM postgres_fitness.daily_metrics FINAL
          WHERE user_id = {userId:UUID} AND provider_id = {providerId:String} AND _peerdb_is_deleted = 0
        UNION ALL
        SELECT count() AS active_count FROM postgres_fitness.sleep_session FINAL
          WHERE user_id = {userId:UUID} AND provider_id = {providerId:String} AND _peerdb_is_deleted = 0
        UNION ALL
        SELECT count() AS active_count FROM postgres_fitness.food_entry FINAL
          WHERE user_id = {userId:UUID} AND provider_id = {providerId:String} AND _peerdb_is_deleted = 0
        UNION ALL
        SELECT count() AS active_count FROM postgres_fitness.health_event FINAL
          WHERE user_id = {userId:UUID} AND provider_id = {providerId:String} AND _peerdb_is_deleted = 0
        UNION ALL
        SELECT count() AS active_count FROM postgres_fitness.lab_panel FINAL
          WHERE user_id = {userId:UUID} AND provider_id = {providerId:String} AND _peerdb_is_deleted = 0
        UNION ALL
        SELECT count() AS active_count FROM postgres_fitness.lab_result FINAL
          WHERE user_id = {userId:UUID} AND provider_id = {providerId:String} AND _peerdb_is_deleted = 0
        UNION ALL
        SELECT count() AS active_count FROM postgres_fitness.journal_entry FINAL
          WHERE user_id = {userId:UUID} AND provider_id = {providerId:String} AND _peerdb_is_deleted = 0
      )`,
    format: "JSONEachRow",
    query_params: { userId, providerId },
  });
  const row = (await rows.json())[0];
  return Number(row?.active_count ?? 0);
}

export async function waitForPeerDbProviderDeletes(
  client: ClickHouseClient,
  userId: string,
  providerId: string,
  options: WaitForPeerDbActivityDeletesOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const activeCount = await countActivePeerDbProviderRows(client, userId, providerId);
    if (activeCount === 0) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Timed out waiting for PeerDB to reflect provider deletion for provider ${providerId}`,
  );
}

async function runReadModelDbtBuild(
  spawnImpl: ActivityReadModelSpawner,
  selectArguments: readonly string[],
  failureDescription: string,
): Promise<void> {
  const targetPath = await mkdtemp(join(tmpdir(), "dofek-dbt-delete-artifacts-"));
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawnImpl(
        "dbt",
        [
          "build",
          "--project-dir",
          "analytics",
          "--profiles-dir",
          "analytics",
          "--threads",
          "1",
          "--target-path",
          targetPath,
          ...selectArguments,
        ],
        {
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      // dbt writes its errors to stdout, so capture both streams to surface the real cause.
      let output = "";
      const appendOutput = (chunk: Buffer | string) => {
        output += String(chunk);
      };
      child.stdout?.on("data", appendOutput);
      child.stderr?.on("data", appendOutput);

      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        const trimmedOutput = output.trim();
        reject(
          new Error(
            `${failureDescription} failed with exit code ${code ?? "unknown"}${trimmedOutput ? `: ${trimmedOutput}` : ""}`,
          ),
        );
      });
    });
  } finally {
    await rm(targetPath, { recursive: true, force: true });
  }
}

export async function runActivityReadModelBuild(
  spawnImpl: ActivityReadModelSpawner = defaultActivityReadModelSpawner,
): Promise<void> {
  await runReadModelDbtBuild(
    spawnImpl,
    ["--select", ACTIVITY_DELETE_DBT_SELECT],
    `dbt build --select ${ACTIVITY_DELETE_DBT_SELECT}`,
  );
}

export async function runProviderDeleteReadModelBuild(
  spawnImpl: ActivityReadModelSpawner = defaultActivityReadModelSpawner,
): Promise<void> {
  await runReadModelDbtBuild(spawnImpl, [], "dbt build after provider deletion");
}
