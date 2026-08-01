import { mkdtemp, rm } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClickHouseClientFromEnv } from "../src/db/clickhouse.ts";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import { AnalyticsBuildError } from "./analytics-build-error.ts";
import { runAnalyticsBuild, runAnalyticsBuildFromEnvironment } from "./run-analytics-build.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    mkdtemp: vi.fn(),
    rm: vi.fn(),
  };
});
vi.mock("../src/db/clickhouse.ts", () => ({
  createClickHouseClientFromEnv: vi.fn(),
}));
vi.mock("../src/db/index.ts", () => ({
  createDatabaseFromEnv: vi.fn(),
}));

const TEST_MICROBATCH_BOUNDS = {
  sensor_scalar_sample_begin: "2025-02-03",
  deduped_sensor_begin: "2025-02-03",
  activity_sensor_sample_begin: "2025-02-03",
  activity_location_sample_begin: "2025-04-05",
} as const;

type TestArtifactModel = {
  uniqueId: string;
  name: string;
  status: "success" | "error" | "skipped";
  executionTime: number;
  message: string | null;
};

function createArtifactReader(invocationId: string, models: readonly TestArtifactModel[]) {
  const nodes = Object.fromEntries(
    models.map((model) => [
      model.uniqueId,
      {
        unique_id: model.uniqueId,
        name: model.name,
        resource_type: "model",
      },
    ]),
  );
  const results = models.map((model) => ({
    unique_id: model.uniqueId,
    status: model.status,
    execution_time: model.executionTime,
    message: model.message,
  }));

  return async (name: "manifest.json" | "run_results.json"): Promise<unknown> =>
    name === "manifest.json"
      ? {
          metadata: { dbt_schema_version: "https://schemas.getdbt.com/dbt/manifest/v12.json" },
          nodes,
        }
      : {
          metadata: { invocation_id: invocationId },
          results,
        };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runAnalyticsBuild", () => {
  it("cleans acquired resources when ClickHouse initialization fails", async () => {
    const initializationError = new Error("CLICKHOUSE_URL is required");
    const endDatabase = vi.fn().mockResolvedValue(undefined);
    vi.mocked(mkdtemp).mockResolvedValue("/tmp/dofek-dbt-test");
    vi.mocked(rm).mockResolvedValue(undefined);
    vi.mocked(createDatabaseFromEnv).mockReturnValue({
      $client: { end: endDatabase },
    });
    vi.mocked(createClickHouseClientFromEnv).mockImplementation(() => {
      throw initializationError;
    });

    await expect(runAnalyticsBuildFromEnvironment()).rejects.toBe(initializationError);

    expect(endDatabase).toHaveBeenCalledOnce();
    expect(rm).toHaveBeenCalledWith("/tmp/dofek-dbt-test", {
      recursive: true,
      force: true,
    });
  });

  it("records every selected model result before returning success", async () => {
    const runDbt = vi.fn(async () => 0);
    const recordRun = vi.fn(async () => ({ datasets: 1, failed: 0 }));
    const readArtifact = createArtifactReader("dbt-run-1", [
      {
        uniqueId: "model.dofek.provider_stats",
        name: "provider_stats",
        status: "success",
        executionTime: 1,
        message: null,
      },
    ]);

    await expect(
      runAnalyticsBuild({
        selectedModels: ["provider_stats"],
        artifactDirectory: "/tmp/dofek-dbt-test",
        microbatchBounds: TEST_MICROBATCH_BOUNDS,
        runDbt,
        readArtifact,
        recordRun,
      }),
    ).resolves.toEqual({ datasets: 1, failed: 0 });

    expect(runDbt).toHaveBeenCalledWith([
      "build",
      "--project-dir",
      "analytics",
      "--profiles-dir",
      "analytics",
      "--threads",
      "1",
      "--target-path",
      "/tmp/dofek-dbt-test",
      "--vars",
      '{"sensor_scalar_sample_begin":"2025-02-03","deduped_sensor_begin":"2025-02-03","activity_sensor_sample_begin":"2025-02-03","activity_location_sample_begin":"2025-04-05"}',
      "--select",
      "provider_stats",
    ]);
    expect(recordRun).toHaveBeenCalledWith({
      runId: "dbt-run-1",
      modelResults: [expect.objectContaining({ name: "provider_stats", status: "succeeded" })],
    });
  });

  it("records failing artifacts and then fails the command", async () => {
    const recordRun = vi.fn(async () => ({ datasets: 1, failed: 1 }));

    await expect(
      runAnalyticsBuild({
        selectedModels: ["provider_stats"],
        artifactDirectory: "/tmp/dofek-dbt-test",
        microbatchBounds: TEST_MICROBATCH_BOUNDS,
        runDbt: async () => 1,
        readArtifact: createArtifactReader("dbt-run-2", [
          {
            uniqueId: "model.dofek.provider_stats",
            name: "provider_stats",
            status: "error",
            executionTime: 1,
            message: "database error",
          },
        ]),
        recordRun,
      }),
    ).rejects.toMatchObject({
      constructor: AnalyticsBuildError,
      message:
        "dbt build failed with exit code 1: provider_stats: database error; analytics processing recorded 1 failed dataset(s)",
      processingFailedCount: 1,
      failures: [
        expect.objectContaining({
          modelName: "provider_stats",
          category: "unknown",
        }),
      ],
    });

    expect(recordRun).toHaveBeenCalledOnce();
  });

  it("preserves processing failures when dbt artifacts are incomplete", async () => {
    const recordRun = vi.fn(async () => ({ datasets: 1, failed: 2 }));

    await expect(
      runAnalyticsBuild({
        selectedModels: ["provider_stats"],
        artifactDirectory: "/tmp/dofek-dbt-test",
        microbatchBounds: TEST_MICROBATCH_BOUNDS,
        runDbt: async () => 0,
        readArtifact: createArtifactReader("dbt-run-combined-failure", [
          {
            uniqueId: "model.dofek.provider_stats",
            name: "provider_stats",
            status: "error",
            executionTime: 1,
            message: "database error",
          },
        ]),
        recordRun,
      }),
    ).rejects.toMatchObject({
      constructor: AnalyticsBuildError,
      message:
        "dbt build did not complete every required analytics model: provider_stats: database error; analytics processing recorded 2 failed dataset(s)",
      processingFailedCount: 2,
    });
  });

  it("reports pending-processing failures separately from dbt failures", async () => {
    const recordRun = vi.fn(async () => ({ datasets: 3, failed: 2 }));

    await expect(
      runAnalyticsBuild({
        selectedModels: ["provider_stats"],
        artifactDirectory: "/tmp/dofek-dbt-test",
        microbatchBounds: TEST_MICROBATCH_BOUNDS,
        runDbt: async () => 0,
        readArtifact: createArtifactReader("dbt-run-processing-failure", [
          {
            uniqueId: "model.dofek.provider_stats",
            name: "provider_stats",
            status: "success",
            executionTime: 1,
            message: null,
          },
        ]),
        recordRun,
      }),
    ).rejects.toThrow(
      "analytics processing recorded 2 failed dataset(s) after dbt completed successfully",
    );
  });

  it("fingerprints failed models instead of skipped dependents", async () => {
    const recordRun = vi.fn(async () => ({ datasets: 2, failed: 2 }));

    await expect(
      runAnalyticsBuild({
        selectedModels: ["provider_stats", "provider_stats_downstream"],
        artifactDirectory: "/tmp/dofek-dbt-test",
        microbatchBounds: TEST_MICROBATCH_BOUNDS,
        runDbt: async () => 1,
        readArtifact: createArtifactReader("dbt-run-3", [
          {
            uniqueId: "model.dofek.provider_stats",
            name: "provider_stats",
            status: "error",
            executionTime: 1,
            message: "Code: 159 TIMEOUT_EXCEEDED",
          },
          {
            uniqueId: "model.dofek.provider_stats_downstream",
            name: "provider_stats_downstream",
            status: "skipped",
            executionTime: 0,
            message: "depends on failed model",
          },
        ]),
        recordRun,
      }),
    ).rejects.toMatchObject({
      constructor: AnalyticsBuildError,
      failures: [
        expect.objectContaining({
          modelName: "provider_stats",
          category: "timeout",
        }),
      ],
    });

    await expect(
      runAnalyticsBuild({
        selectedModels: ["provider_stats"],
        artifactDirectory: "/tmp/dofek-dbt-test",
        microbatchBounds: TEST_MICROBATCH_BOUNDS,
        runDbt: async () => 0,
        readArtifact: createArtifactReader("dbt-run-4", [
          {
            uniqueId: "model.dofek.provider_stats",
            name: "provider_stats",
            status: "skipped",
            executionTime: 0,
            message: null,
          },
        ]),
        recordRun,
      }),
    ).rejects.toMatchObject({
      constructor: AnalyticsBuildError,
      exitCode: 0,
      message:
        "dbt build did not complete every required analytics model: provider_stats: skipped; analytics processing recorded 2 failed dataset(s)",
    });
  });
});
