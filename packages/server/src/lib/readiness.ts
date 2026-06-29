import { sql } from "drizzle-orm";
import { z } from "zod";
import { checkWorkerQueues } from "../../../../src/jobs/worker-health.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { executeWithSchema } from "./typed-sql.ts";

type ExecutableDatabase = Parameters<typeof executeWithSchema>[0];

export interface ReadinessDependencies {
  db: ExecutableDatabase;
  sensorStore: ActivitySensorStore;
}

interface ReadinessChecks {
  postgres: "ok" | "error";
  clickhouse: "ok" | "error";
  queues: "ok" | "error";
}

export interface ReadinessResult {
  status: "ok" | "error";
  checks: ReadinessChecks;
}

const postgresReadySchema = z.object({ ok: z.union([z.number(), z.string()]) });
const clickHouseReadySchema = z.object({ ok: z.union([z.number(), z.string()]) });

async function checkPostgres(db: ExecutableDatabase): Promise<void> {
  await executeWithSchema(db, postgresReadySchema, sql`SELECT 1 AS ok`);
}

async function checkClickHouse(sensorStore: ActivitySensorStore): Promise<void> {
  await sensorStore.query(clickHouseReadySchema, "SELECT 1 AS ok");
}

async function checkQueues(): Promise<void> {
  await checkWorkerQueues();
}

function statusFromResult(result: PromiseSettledResult<unknown>): "ok" | "error" {
  return result.status === "fulfilled" ? "ok" : "error";
}

export async function checkReadiness(
  dependencies: ReadinessDependencies,
): Promise<ReadinessResult> {
  const [postgresResult, clickHouseResult, queueResult] = await Promise.allSettled([
    checkPostgres(dependencies.db),
    checkClickHouse(dependencies.sensorStore),
    checkQueues(),
  ]);
  const checks: ReadinessChecks = {
    postgres: statusFromResult(postgresResult),
    clickhouse: statusFromResult(clickHouseResult),
    queues: statusFromResult(queueResult),
  };
  const status = Object.values(checks).every((checkStatus) => checkStatus === "ok")
    ? "ok"
    : "error";

  return { status, checks };
}
