import { type SpawnOptions, spawn } from "node:child_process";
import type { ClickHouseClient } from "../db/clickhouse.ts";

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

export async function runActivityReadModelBuild(
  spawnImpl: ActivityReadModelSpawner = defaultActivityReadModelSpawner,
): Promise<void> {
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
        "--select",
        ACTIVITY_DELETE_DBT_SELECT,
      ],
      {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk: Buffer | string) => {
        output += String(chunk);
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `dbt build --select ${ACTIVITY_DELETE_DBT_SELECT} failed with exit code ${code ?? "unknown"}${output ? `: ${output.trim()}` : ""}`,
        ),
      );
    });
  });
}
