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
    const readArtifact = vi.fn(async (name: string) => {
      if (name === "manifest.json") {
        return {
          metadata: { dbt_schema_version: "https://schemas.getdbt.com/dbt/manifest/v12.json" },
          nodes: {
            "model.dofek.provider_stats": {
              unique_id: "model.dofek.provider_stats",
              name: "provider_stats",
              resource_type: "model",
            },
          },
        };
      }
      return {
        metadata: { invocation_id: "dbt-run-1" },
        results: [
          {
            unique_id: "model.dofek.provider_stats",
            status: "success",
            execution_time: 1,
            message: null,
          },
        ],
      };
    });

    await expect(
      runAnalyticsBuild({
        selectedModels: ["provider_stats"],
        artifactDirectory: "/tmp/dofek-dbt-test",
        microbatchBounds: {
          sensor_scalar_sample_begin: "2025-02-03",
          deduped_sensor_begin: "2025-02-03",
          activity_sensor_sample_begin: "2025-02-03",
          activity_location_sample_begin: "2025-04-05",
        },
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
        microbatchBounds: {
          sensor_scalar_sample_begin: "2025-02-03",
          deduped_sensor_begin: "2025-02-03",
          activity_sensor_sample_begin: "2025-02-03",
          activity_location_sample_begin: "2025-04-05",
        },
        runDbt: async () => 1,
        readArtifact: async (name) =>
          name === "manifest.json"
            ? {
                metadata: {
                  dbt_schema_version: "https://schemas.getdbt.com/dbt/manifest/v12.json",
                },
                nodes: {
                  "model.dofek.provider_stats": {
                    unique_id: "model.dofek.provider_stats",
                    name: "provider_stats",
                    resource_type: "model",
                  },
                },
              }
            : {
                metadata: { invocation_id: "dbt-run-2" },
                results: [
                  {
                    unique_id: "model.dofek.provider_stats",
                    status: "error",
                    execution_time: 1,
                    message: "database error",
                  },
                ],
              },
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
        microbatchBounds: {
          sensor_scalar_sample_begin: "2025-02-03",
          deduped_sensor_begin: "2025-02-03",
          activity_sensor_sample_begin: "2025-02-03",
          activity_location_sample_begin: "2025-04-05",
        },
        runDbt: async () => 0,
        readArtifact: async (name) =>
          name === "manifest.json"
            ? {
                metadata: {
                  dbt_schema_version: "https://schemas.getdbt.com/dbt/manifest/v12.json",
                },
                nodes: {
                  "model.dofek.provider_stats": {
                    unique_id: "model.dofek.provider_stats",
                    name: "provider_stats",
                    resource_type: "model",
                  },
                },
              }
            : {
                metadata: { invocation_id: "dbt-run-combined-failure" },
                results: [
                  {
                    unique_id: "model.dofek.provider_stats",
                    status: "error",
                    execution_time: 1,
                    message: "database error",
                  },
                ],
              },
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
        microbatchBounds: {
          sensor_scalar_sample_begin: "2025-02-03",
          deduped_sensor_begin: "2025-02-03",
          activity_sensor_sample_begin: "2025-02-03",
          activity_location_sample_begin: "2025-04-05",
        },
        runDbt: async () => 0,
        readArtifact: async (name) =>
          name === "manifest.json"
            ? {
                metadata: {
                  dbt_schema_version: "https://schemas.getdbt.com/dbt/manifest/v12.json",
                },
                nodes: {
                  "model.dofek.provider_stats": {
                    unique_id: "model.dofek.provider_stats",
                    name: "provider_stats",
                    resource_type: "model",
                  },
                },
              }
            : {
                metadata: { invocation_id: "dbt-run-processing-failure" },
                results: [
                  {
                    unique_id: "model.dofek.provider_stats",
                    status: "success",
                    execution_time: 1,
                    message: null,
                  },
                ],
              },
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
        microbatchBounds: {
          sensor_scalar_sample_begin: "2025-02-03",
          deduped_sensor_begin: "2025-02-03",
          activity_sensor_sample_begin: "2025-02-03",
          activity_location_sample_begin: "2025-04-05",
        },
        runDbt: async () => 1,
        readArtifact: async (name) =>
          name === "manifest.json"
            ? {
                metadata: {
                  dbt_schema_version: "https://schemas.getdbt.com/dbt/manifest/v12.json",
                },
                nodes: {
                  "model.dofek.provider_stats": {
                    unique_id: "model.dofek.provider_stats",
                    name: "provider_stats",
                    resource_type: "model",
                  },
                  "model.dofek.provider_stats_downstream": {
                    unique_id: "model.dofek.provider_stats_downstream",
                    name: "provider_stats_downstream",
                    resource_type: "model",
                  },
                },
              }
            : {
                metadata: { invocation_id: "dbt-run-3" },
                results: [
                  {
                    unique_id: "model.dofek.provider_stats",
                    status: "error",
                    execution_time: 1,
                    message: "Code: 159 TIMEOUT_EXCEEDED",
                  },
                  {
                    unique_id: "model.dofek.provider_stats_downstream",
                    status: "skipped",
                    execution_time: 0,
                    message: "depends on failed model",
                  },
                ],
              },
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
        microbatchBounds: {
          sensor_scalar_sample_begin: "2025-02-03",
          deduped_sensor_begin: "2025-02-03",
          activity_sensor_sample_begin: "2025-02-03",
          activity_location_sample_begin: "2025-04-05",
        },
        runDbt: async () => 0,
        readArtifact: async (name) =>
          name === "manifest.json"
            ? {
                metadata: {
                  dbt_schema_version: "https://schemas.getdbt.com/dbt/manifest/v12.json",
                },
                nodes: {
                  "model.dofek.provider_stats": {
                    unique_id: "model.dofek.provider_stats",
                    name: "provider_stats",
                    resource_type: "model",
                  },
                },
              }
            : {
                metadata: { invocation_id: "dbt-run-4" },
                results: [
                  {
                    unique_id: "model.dofek.provider_stats",
                    status: "skipped",
                    execution_time: 0,
                    message: null,
                  },
                ],
              },
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
