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
import { recordProcessingAnalyticsRun } from "../src/processing/analytics-processing.ts";
import { PRODUCTION_DBT_MODELS } from "../src/processing/dataset-contracts.ts";
import { parseDbtRunArtifacts } from "../src/processing/dbt-run-results.ts";
import {
  listProcessingDatasetsAwaitingAnalytics,
  type ProcessingOperationDataset,
} from "../src/processing/processing-event-store.ts";
import { AnalyticsBuildError, createAnalyticsBuildFailure } from "./analytics-build-error.ts";

interface RunAnalyticsBuildInput {
  selectedModels: readonly string[];
  artifactDirectory: string;
  microbatchBounds: AnalyticsMicrobatchBounds;
  loadPendingDatasets(): Promise<ProcessingOperationDataset[]>;
  runDbt(argumentsList: readonly string[]): Promise<number>;
  readArtifact(name: "manifest.json" | "run_results.json"): Promise<unknown>;
  projectCyclingPower(): Promise<{
    pendingActivities: number;
    pendingUsers: number;
    projectedUsers: number;
  }>;
  recordRun(input: {
    runId: string;
    pendingDatasets: readonly ProcessingOperationDataset[];
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
  loadPendingDatasets,
  runDbt,
  readArtifact,
  recordRun,
  projectCyclingPower,
}: RunAnalyticsBuildInput): Promise<{ datasets: number; failed: number }> {
  if (selectedModels.length === 0) {
    throw new Error("Analytics build requires at least one selected model");
  }
  const downstreamModels = new Set(["healthspan_activity_zone_minutes", "weekly_healthspan"]);
  const inputs = selectedModels.filter((model) => !downstreamModels.has(model));
  const downstream = selectedModels.filter((model) => downstreamModels.has(model));
  const pendingDatasets = await loadPendingDatasets();
  const modelResults: ReturnType<typeof parseDbtRunArtifacts>["models"] = [];
  let runId = "";
  let exitCode = 0;
  let succeeded = true;
  const sourceArtifact = {
    metadata: { dbt_schema_version: "https://schemas.getdbt.com/dbt/sources/v3.json" },
    results: [],
  };
  const runPhase = async (models: readonly string[]) => {
    const code = await runDbt([
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
      models.join(" "),
    ]);
    const manifest = await readDbtArtifact(readArtifact, "manifest.json", code);
    const runResults = await readDbtArtifact(readArtifact, "run_results.json", code);
    const phase = parseDbtRunArtifacts({
      manifest,
      runResults,
      sources: sourceArtifact,
      selectedModels: models,
    });
    runId = phase.invocationId;
    exitCode = code;
    succeeded = phase.succeeded;
    modelResults.push(...phase.models);
    return { manifest, runResults };
  };
  if (inputs.length > 0) {
    const inputArtifacts = await runPhase(inputs);
    if ((exitCode !== 0 || !succeeded) && downstream.length > 0) {
      modelResults.push(
        ...parseDbtRunArtifacts({
          ...inputArtifacts,
          sources: sourceArtifact,
          selectedModels: downstream,
        }).models,
      );
    }
  }
  if (exitCode === 0 && succeeded) {
    const projection = await projectCyclingPower();
    if (projection.pendingActivities > 0 || projection.pendingUsers > 0) {
      throw new Error(
        `Cycling power projection has pending work: ${projection.pendingActivities} activities and ${projection.pendingUsers} users`,
      );
    }
    if (downstream.length > 0) await runPhase(downstream);
  }
  const artifacts = { invocationId: runId, succeeded, models: modelResults };
  const processingResult = await recordRun({
    runId: artifacts.invocationId,
    pendingDatasets,
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
        const pendingDatasets = await listProcessingDatasetsAwaitingAnalytics(database);
        const microbatchBounds = await resolveAnalyticsMicrobatchBounds(clickHouse);
        const result = await runAnalyticsBuild({
          selectedModels: PRODUCTION_DBT_MODELS,
          artifactDirectory,
          microbatchBounds,
          loadPendingDatasets: async () => pendingDatasets,
          runDbt: runDbtProcess,
          readArtifact: async (name) => {
            const serializedArtifact = await readFile(join(artifactDirectory, name), "utf8");
            const parsedArtifact: unknown = JSON.parse(serializedArtifact);
            return parsedArtifact;
          },
          projectCyclingPower: async () => {
            const { projectCyclingPower } = await import(
              "../src/analytics/cycling-power-projector.ts"
            );
            const { cyclingPowerPolicy } = await import("../src/analytics/cycling-power-policy.ts");
            return projectCyclingPower(clickHouse, cyclingPowerPolicy);
          },
          recordRun: (run) => recordProcessingAnalyticsRun(database, run),
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
