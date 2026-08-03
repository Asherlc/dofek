import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createClickHouseClientFromEnv } from "../src/db/clickhouse.ts";
import { captureException } from "../src/lib/error-reporting.ts";
import {
  type AnalyticsMicrobatchQueryClient,
  resolveAnalyticsMicrobatchBounds,
} from "../src/processing/analytics-microbatch-bounds.ts";

interface RunLocalAnalyticsBuildInput {
  clickHouse: AnalyticsMicrobatchQueryClient;
  now?: Date;
  runDbt(argumentsList: readonly string[]): Promise<number>;
}

export async function runLocalAnalyticsBuild({
  clickHouse,
  now,
  runDbt,
}: RunLocalAnalyticsBuildInput): Promise<void> {
  const microbatchBounds = await resolveAnalyticsMicrobatchBounds(clickHouse, now);
  const exitCode = await runDbt([
    "run",
    "--project",
    "analytics",
    "dbt",
    "build",
    "--project-dir",
    "analytics",
    "--profiles-dir",
    "analytics",
    "--vars",
    JSON.stringify(microbatchBounds),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Local dbt build failed with exit code ${exitCode}`);
  }
}

function runUvProcess(argumentsList: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("uv", argumentsList, {
      stdio: "inherit",
      env: {
        ...process.env,
        DBT_TARGET: "dev",
        UV_PROJECT_ENVIRONMENT: "../.venv-analytics",
      },
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode ?? 1));
  });
}

async function runLocalAnalyticsBuildFromEnvironment(): Promise<void> {
  const clickHouse = createClickHouseClientFromEnv();
  try {
    await runLocalAnalyticsBuild({
      clickHouse,
      runDbt: runUvProcess,
    });
  } finally {
    await clickHouse.close?.();
  }
}

const scriptPath = process.argv[1];
if (scriptPath && import.meta.url === pathToFileURL(scriptPath).href) {
  try {
    await runLocalAnalyticsBuildFromEnvironment();
  } catch (error: unknown) {
    captureException(error);
    throw error;
  }
}
