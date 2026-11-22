import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { ActivitySearchIndex } from "../src/activity-search/opensearch.ts";
import { ACTIVITY_SEARCH_PUBLICATION_OWNER } from "../src/activity-search/publication.ts";
import {
  listChangedActivityTitles,
  publishActivitySearchChanges,
} from "../src/activity-search/publisher.ts";
import {
  ANALYTICS_PUBLICATION_RESOURCE,
  withAnalyticsQueryOwner,
} from "../src/analytics/analytics-query-owner.ts";
import { runOwnedDbtBuild } from "../src/analytics/dbt-build.ts";
import { withAccountErasureUserWriteFence } from "../src/db/account-erasure.ts";
import { createClickHouseClientFromEnv } from "../src/db/clickhouse.ts";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import {
  type AnalyticsMicrobatchBounds,
  resolveAnalyticsMicrobatchBounds,
} from "../src/processing/analytics-microbatch-bounds.ts";
import { recordProcessingAnalyticsRun } from "../src/processing/analytics-processing.ts";
import {
  CYCLING_POWER_DOWNSTREAM_DBT_MODELS,
  PRODUCTION_DBT_MODELS,
} from "../src/processing/dataset-contracts.ts";
import { parseDbtRunArtifacts } from "../src/processing/dbt-run-results.ts";
import {
  listProcessingDatasetsAwaitingAnalytics,
  type ProcessingOperationDataset,
} from "../src/processing/processing-event-store.ts";
import { AnalyticsBuildError, createAnalyticsBuildFailure } from "./analytics-build-error.ts";

/** Only these models write a bounded batch and need a drain before publication. */
const BOUNDED_MODEL_TABLES = {
  activity_fit_heart_rate: "analytics.activity_fit_heart_rate",
  activity_polarization_zones: "analytics.activity_cycling_polarization",
} as const;

type BoundedModelName = keyof typeof BOUNDED_MODEL_TABLES;

function isBoundedModel(model: string): model is BoundedModelName {
  return Object.hasOwn(BOUNDED_MODEL_TABLES, model);
}

interface RunAnalyticsBuildInput {
  selectedModels: readonly string[];
  artifactDirectory: string;
  microbatchBounds: AnalyticsMicrobatchBounds;
  loadPendingDatasets(): Promise<ProcessingOperationDataset[]>;
  runDbt(argumentsList: readonly string[]): Promise<number>;
  readArtifact(name: "manifest.json" | "run_results.json"): Promise<unknown>;
  projectCyclingPower(asOf: Date): Promise<{
    pendingActivities: number;
  }>;
  /** Fingerprint of the rows written by `model`; required when a bounded model is selected. */
  readBoundedModelFingerprint?(model: BoundedModelName): Promise<string>;
  recordRun(input: {
    runId: string;
    pendingDatasets: readonly ProcessingOperationDataset[];
    modelResults: ReturnType<typeof parseDbtRunArtifacts>["models"];
  }): Promise<{ datasets: number; failed: number }>;
}

const boundedModelFingerprintSchema = z.object({ row_count: z.string(), checksum: z.string() });
const MAX_BOUNDED_MODEL_DRAIN_PASSES = 1_000;

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
  readBoundedModelFingerprint,
}: RunAnalyticsBuildInput): Promise<{ datasets: number; failed: number }> {
  if (selectedModels.length === 0) {
    throw new Error("Analytics build requires at least one selected model");
  }
  const downstreamModels = new Set<string>(CYCLING_POWER_DOWNSTREAM_DBT_MODELS);
  const inputs = selectedModels.filter((model) => !downstreamModels.has(model));
  const downstream = selectedModels.filter((model) => downstreamModels.has(model));
  const pendingDatasets = await loadPendingDatasets();
  const modelResults: ReturnType<typeof parseDbtRunArtifacts>["models"] = [];
  const convergedBoundedModels = new Set<BoundedModelName>();
  let runId = "";
  let exitCode = 0;
  let succeeded = true;
  const sourceArtifact = {
    metadata: { dbt_schema_version: "https://schemas.getdbt.com/dbt/sources/v3.json" },
    results: [],
  };
  const dbtArguments = (models: readonly string[]) => [
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
  ];
  const runPhase = async (models: readonly string[]) => {
    const code = await runDbt(dbtArguments(models));
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
    for (const model of inputs) {
      if (!succeeded) break;
      if (!isBoundedModel(model)) continue;
      if (!readBoundedModelFingerprint) {
        throw new Error(`${model} is selected but no fingerprint reader was provided`);
      }
      // Each model processes a bounded batch per run; repeat until a run writes nothing new.
      let fingerprint = await readBoundedModelFingerprint(model);
      for (let pass = 0; ; pass += 1) {
        if (pass >= MAX_BOUNDED_MODEL_DRAIN_PASSES) {
          throw new Error(
            `${model} still had pending activities after ${MAX_BOUNDED_MODEL_DRAIN_PASSES} extra passes`,
          );
        }
        const code = await runDbt(dbtArguments([model]));
        if (code !== 0) {
          // Record this pass's failure like any other phase so affected imports show failed.
          const failed = parseDbtRunArtifacts({
            manifest: await readDbtArtifact(readArtifact, "manifest.json", code),
            runResults: await readDbtArtifact(readArtifact, "run_results.json", code),
            sources: sourceArtifact,
            selectedModels: [model],
          });
          modelResults.splice(
            0,
            modelResults.length,
            ...modelResults.filter((result) => result.name !== model),
            ...failed.models,
          );
          runId = failed.invocationId;
          exitCode = code;
          succeeded = false;
          break;
        }
        const next = await readBoundedModelFingerprint(model);
        if (next === fingerprint) {
          convergedBoundedModels.add(model);
          break;
        }
        fingerprint = next;
      }
    }
  }
  if (exitCode === 0 && succeeded) {
    const asOf = new Date();
    let previousPending = Number.POSITIVE_INFINITY;
    while (true) {
      const projection = await projectCyclingPower(asOf);
      const pending = projection.pendingActivities;
      if (pending === 0) break;
      if (pending >= previousPending) {
        throw new Error(
          `Cycling power projection made no progress: ${projection.pendingActivities} activities remain`,
        );
      }
      previousPending = pending;
    }
    if (downstream.length > 0) await runPhase(downstream);
  }
  // The initial phase can report a bounded model as succeeded even when no drain ran (e.g. an
  // unrelated input failed, or an earlier drain failed). Never publish that result as complete.
  for (const [index, result] of modelResults.entries()) {
    if (
      result.status === "succeeded" &&
      isBoundedModel(result.name) &&
      !convergedBoundedModels.has(result.name)
    ) {
      modelResults[index] = {
        ...result,
        status: "skipped",
        message: "Bounded refresh did not finish",
      };
    }
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

export async function runAnalyticsBuildFromEnvironment(
  activitySearchIndex?: ActivitySearchIndex,
): Promise<void> {
  const { mkdtemp } = await import("node:fs/promises");
  const artifactDirectory = await mkdtemp(join(tmpdir(), "dofek-dbt-artifacts-"));
  try {
    const database = createDatabaseFromEnv();
    try {
      const clickHouse = createClickHouseClientFromEnv();
      try {
        await withAnalyticsQueryOwner(
          database,
          clickHouse,
          { resourceId: ANALYTICS_PUBLICATION_RESOURCE, intentId: "analytics-build" },
          async (owner) => {
            const pendingDatasets = await listProcessingDatasetsAwaitingAnalytics(database);
            const microbatchBounds = await resolveAnalyticsMicrobatchBounds(owner.client);
            const result = await runAnalyticsBuild({
              selectedModels: PRODUCTION_DBT_MODELS,
              artifactDirectory,
              microbatchBounds,
              loadPendingDatasets: async () => pendingDatasets,
              runDbt: (args) =>
                runOwnedDbtBuild(
                  owner,
                  artifactDirectory,
                  args[args.indexOf("--select") + 1]?.split(" ") ?? "all",
                  () => runDbtProcess(args),
                ),
              readArtifact: async (name) => {
                const serializedArtifact = await readFile(join(artifactDirectory, name), "utf8");
                const parsedArtifact: unknown = JSON.parse(serializedArtifact);
                return parsedArtifact;
              },
              projectCyclingPower: async (asOf) => {
                const { projectCyclingPower } = await import(
                  "../src/analytics/cycling-power-projector.ts"
                );
                const { cyclingPowerPolicy } = await import(
                  "../src/analytics/cycling-power-policy.ts"
                );
                return projectCyclingPower(owner, cyclingPowerPolicy, asOf);
              },
              readBoundedModelFingerprint: async (model) => {
                // A clock-independent fingerprint of every written row version. FINAL folds
                // background replacement merges so only new writes change the fingerprint.
                const result = await owner.client.query({
                  query: `SELECT
                      toString(count()) AS row_count,
                      toString(sum(cityHash64(user_id, activity_id, refresh_version))) AS checksum
                    FROM ${BOUNDED_MODEL_TABLES[model]} FINAL`,
                  format: "JSONEachRow",
                });
                const fingerprint = boundedModelFingerprintSchema.parse((await result.json())[0]);
                return `${fingerprint.row_count}:${fingerprint.checksum}`;
              },
              recordRun: (run) => recordProcessingAnalyticsRun(database, run),
            });
            console.log(
              `[analytics-processing] recorded ${result.datasets} datasets; ${result.failed} failed`,
            );
          },
        );
        if (activitySearchIndex) {
          await withAnalyticsQueryOwner(
            database,
            clickHouse,
            ACTIVITY_SEARCH_PUBLICATION_OWNER,
            (owner) =>
              publishActivitySearchChanges({
                assertActive: () => owner.assertActive(),
                loadBatch: (checkpoint) => listChangedActivityTitles(owner.client, checkpoint),
                withWriteFence: (userId, write) =>
                  withAccountErasureUserWriteFence(database, userId, write),
                index: {
                  loadState: () => activitySearchIndex.loadState(),
                  saveState: (state) =>
                    activitySearchIndex.saveState(state, owner.runSynchronousRequest),
                  applyChanges: (changes) =>
                    activitySearchIndex.applyChanges(changes, owner.runSynchronousRequest),
                },
              }),
          );
        }
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
