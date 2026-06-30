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

const postgresReadySchema = z.object({ inRecovery: z.boolean() });
const clickHouseReadySchema = z.object({ ok: z.union([z.number(), z.string()]) });
const QUEUE_READINESS_TIMEOUT_MS = 2_500;

async function checkPostgres(db: ExecutableDatabase): Promise<void> {
  const [row] = await executeWithSchema(
    db,
    postgresReadySchema,
    sql`SELECT pg_is_in_recovery() AS "inRecovery"`,
  );
  if (!row || row.inRecovery) {
    throw new Error("Postgres is in recovery mode");
  }
}

async function checkClickHouse(sensorStore: ActivitySensorStore): Promise<void> {
  await sensorStore.query(clickHouseReadySchema, "SELECT 1 AS ok");
}

async function checkQueues(): Promise<void> {
  await checkWorkerQueues({ timeoutMs: QUEUE_READINESS_TIMEOUT_MS });
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
