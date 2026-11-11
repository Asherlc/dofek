import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ANALYTICS_PUBLICATION_RESOURCE,
  type AnalyticsQueryOwner,
  withAnalyticsQueryOwner,
} from "../src/analytics/analytics-query-owner.ts";
import { runOwnedDbtBuild } from "../src/analytics/dbt-build.ts";
import { createClickHouseClientFromEnv } from "../src/db/clickhouse.ts";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import { captureException } from "../src/lib/error-reporting.ts";
import {
  type AnalyticsMicrobatchQueryClient,
  resolveAnalyticsMicrobatchBounds,
} from "../src/processing/analytics-microbatch-bounds.ts";

interface RunLocalAnalyticsBuildInput {
  owner: Pick<AnalyticsQueryOwner, "assertActive" | "runSynchronousDbt"> & {
    client: AnalyticsMicrobatchQueryClient;
  };
  artifactDirectory: string;
  now?: Date;
  runDbt(argumentsList: readonly string[]): Promise<number>;
}

export async function runLocalAnalyticsBuild({
  owner,
  artifactDirectory,
  now,
  runDbt,
}: RunLocalAnalyticsBuildInput): Promise<void> {
  await owner.assertActive();
  const microbatchBounds = await resolveAnalyticsMicrobatchBounds(owner.client, now);
  const exitCode = await runOwnedDbtBuild(owner, artifactDirectory, "all", () =>
    runDbt([
      "run",
      "--project",
      "analytics",
      "dbt",
      "build",
      "--project-dir",
      "analytics",
      "--profiles-dir",
      "analytics",
      "--target-path",
      artifactDirectory,
      "--vars",
      JSON.stringify(microbatchBounds),
    ]),
  );
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
    const database = createDatabaseFromEnv();
    try {
      const artifactDirectory = await mkdtemp(join(tmpdir(), "dofek-local-dbt-artifacts-"));
      try {
        await withAnalyticsQueryOwner(
          database,
          clickHouse,
          { resourceId: ANALYTICS_PUBLICATION_RESOURCE, intentId: "analytics-local-build" },
          (owner) => runLocalAnalyticsBuild({ owner, artifactDirectory, runDbt: runUvProcess }),
        );
      } finally {
        await rm(artifactDirectory, { recursive: true, force: true });
      }
    } finally {
      await database.$client.end();
    }
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
