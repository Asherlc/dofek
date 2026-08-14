import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClickHouseClientFromEnv } from "../src/db/clickhouse.ts";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import {
  type AnalyticsMicrobatchBounds,
  resolveAnalyticsMicrobatchBounds,
} from "../src/processing/analytics-microbatch-bounds.ts";
import { recordAnalyticsRunForPendingProcessing } from "../src/processing/analytics-processing.ts";
import { PRODUCTION_DBT_MODELS } from "../src/processing/dataset-contracts.ts";
import { parseDbtRunArtifacts } from "../src/processing/dbt-run-results.ts";
import { AnalyticsBuildError, createAnalyticsBuildFailure } from "./analytics-build-error.ts";

interface RunAnalyticsBuildInput {
  selectedModels: readonly string[];
  artifactDirectory: string;
  microbatchBounds: AnalyticsMicrobatchBounds;
  runDbt(argumentsList: readonly string[]): Promise<number>;
  readArtifact(name: "manifest.json" | "run_results.json"): Promise<unknown>;
  recordRun(input: {
    runId: string;
    modelResults: ReturnType<typeof parseDbtRunArtifacts>["models"];
  }): Promise<{ datasets: number; failed: number }>;
}

function isMissingArtifactError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readDbtArtifact(
  readArtifact: RunAnalyticsBuildInput["readArtifact"],
  name: "manifest.json" | "run_results.json",
  exitCode: number,
): Promise<unknown> {
  try {
    return await readArtifact(name);
  } catch (error: unknown) {
    if (!isMissingArtifactError(error)) throw error;
    throw new AnalyticsBuildError(exitCode, [
      {
        modelName: "dbt",
        status: "failed",
        errorCode: "dbt_artifact_missing",
        message: `dbt did not produce ${name}`,
        category: "unknown",
      },
    ]);
  }
}

export async function runAnalyticsBuild({
  selectedModels,
  artifactDirectory,
  microbatchBounds,
  runDbt,
  readArtifact,
  recordRun,
}: RunAnalyticsBuildInput): Promise<{ datasets: number; failed: number }> {
  if (selectedModels.length === 0) {
    throw new Error("Analytics build requires at least one selected model");
  }
  const commandArguments = [
    "build",
    "--project-dir",
    "analytics",
    "--profiles-dir",
    "analytics",
    "--threads",
    "1",
    "--target-path",
    artifactDirectory,
    "--vars",
    JSON.stringify(microbatchBounds),
    "--select",
    selectedModels.join(" "),
  ];
  const exitCode = await runDbt(commandArguments);
  const artifacts = parseDbtRunArtifacts({
    manifest: await readDbtArtifact(readArtifact, "manifest.json", exitCode),
    runResults: await readDbtArtifact(readArtifact, "run_results.json", exitCode),
    sources: {
      metadata: { dbt_schema_version: "https://schemas.getdbt.com/dbt/sources/v3.json" },
      results: [],
    },
    selectedModels,
  });
  const processingResult = await recordRun({
    runId: artifacts.invocationId,
    modelResults: artifacts.models,
  });
  const incompleteModels = artifacts.models.filter((model) => model.status !== "succeeded");
  const failedModels = incompleteModels
    .filter((model) => model.status === "failed")
    .map(createAnalyticsBuildFailure);
  const incompleteFailures =
    failedModels.length > 0 ? failedModels : incompleteModels.map(createAnalyticsBuildFailure);

  if (exitCode !== 0) {
    throw new AnalyticsBuildError(
      exitCode,
      incompleteFailures,
      "process-failed",
      processingResult.failed,
    );
  }
  if (!artifacts.succeeded) {
    throw new AnalyticsBuildError(
      exitCode,
      incompleteFailures,
      "incomplete",
      processingResult.failed,
    );
  }
  if (processingResult.failed > 0) {
    throw new Error(
      `analytics processing recorded ${processingResult.failed} failed dataset(s) after dbt completed successfully`,
    );
  }
  return processingResult;
}

function runDbtProcess(argumentsList: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("dbt", argumentsList, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode ?? 1));
  });
}

export async function runAnalyticsBuildFromEnvironment(): Promise<void> {
  const { mkdtemp } = await import("node:fs/promises");
  const artifactDirectory = await mkdtemp(join(tmpdir(), "dofek-dbt-artifacts-"));
  try {
    const database = createDatabaseFromEnv();
    try {
      const clickHouse = createClickHouseClientFromEnv();
      try {
        const microbatchBounds = await resolveAnalyticsMicrobatchBounds(clickHouse);
        const result = await runAnalyticsBuild({
          selectedModels: PRODUCTION_DBT_MODELS,
          artifactDirectory,
          microbatchBounds,
          runDbt: runDbtProcess,
          readArtifact: async (name) => {
            const serializedArtifact = await readFile(join(artifactDirectory, name), "utf8");
            const parsedArtifact: unknown = JSON.parse(serializedArtifact);
            return parsedArtifact;
          },
          recordRun: (run) => recordAnalyticsRunForPendingProcessing(database, run),
        });
        console.log(
          `[analytics-processing] recorded ${result.datasets} datasets; ${result.failed} failed`,
        );
      } finally {
        await clickHouse.close?.();
      }
    } finally {
      await database.$client.end();
    }
  } finally {
    await rm(artifactDirectory, { recursive: true, force: true });
  }
}

const scriptPath = process.argv[1];
if (scriptPath && import.meta.url === pathToFileURL(scriptPath).href) {
  await runAnalyticsBuildFromEnvironment();
}
