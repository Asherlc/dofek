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
  it("builds threshold-dependent models after projection and records both phases together", async () => {
    const order: string[] = [];
    let phase = 0;
    const selected = [
      "activity_summary_rows",
      "cycling_threshold_history",
      "cycling_activity_power_metrics",
      "healthspan_activity_zone_minutes",
      "weekly_healthspan",
    ];
    const recordRun = vi.fn(async () => {
      order.push("record");
      return { datasets: 1, failed: 0 };
    });
    await runAnalyticsBuild({
      selectedModels: selected,
      artifactDirectory: "/tmp/two-phase",
      microbatchBounds: TEST_MICROBATCH_BOUNDS,
      loadPendingDatasets: async () => [],
      runDbt: async (args) => {
        order.push(`dbt:${args.at(-1)}`);
        phase += 1;
        return 0;
      },
      readArtifact: async (name) =>
        createArtifactReader(
          `phase-${phase}`,
          selected.map((model) => ({
            uniqueId: `model.dofek.${model}`,
            name: model,
            status: "success",
            executionTime: 1,
            message: null,
          })),
        )(name),
      projectCyclingPower: async () => {
        order.push("project");
        return { pendingActivities: 0, pendingUsers: 0, projectedUsers: 1 };
      },
      recordRun,
    });
    expect(order).toEqual([
      "dbt:activity_summary_rows",
      "project",
      "dbt:cycling_threshold_history cycling_activity_power_metrics healthspan_activity_zone_minutes weekly_healthspan",
      "record",
    ]);
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        modelResults: selected.map((name) =>
          expect.objectContaining({ name, status: "succeeded" }),
        ),
      }),
    );
  });

  it("records downstream failure without claiming the input phase completed the dataset", async () => {
    let phase = 0;
    const selected = [
      "activity_summary_rows",
      "healthspan_activity_zone_minutes",
      "weekly_healthspan",
    ];
    const recordRun = vi.fn(async () => ({ datasets: 1, failed: 1 }));
    await expect(
      runAnalyticsBuild({
        selectedModels: selected,
        artifactDirectory: "/tmp/two-phase-failure",
        microbatchBounds: TEST_MICROBATCH_BOUNDS,
        loadPendingDatasets: async () => [],
        runDbt: async () => (++phase === 1 ? 0 : 1),
        readArtifact: async (name) =>
          createArtifactReader(
            `phase-${phase}`,
            selected.map((model) => ({
              uniqueId: `model.dofek.${model}`,
              name: model,
              status: phase === 2 && model !== "activity_summary_rows" ? "error" : "success",
              executionTime: 1,
              message: phase === 2 ? "Downstream failed" : null,
            })),
          )(name),
        projectCyclingPower: async () => ({
          pendingActivities: 0,
          pendingUsers: 0,
          projectedUsers: 1,
        }),
        recordRun,
      }),
    ).rejects.toBeInstanceOf(AnalyticsBuildError);
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        modelResults: [
          expect.objectContaining({ name: "activity_summary_rows", status: "succeeded" }),
          expect.objectContaining({ name: "healthspan_activity_zone_minutes", status: "failed" }),
          expect.objectContaining({ name: "weekly_healthspan", status: "failed" }),
        ],
      }),
    );
  });

  it("does not run downstream models when an input model failed", async () => {
    const selected = [
      "activity_summary_rows",
      "healthspan_activity_zone_minutes",
      "weekly_healthspan",
    ];
    const projectCyclingPower = vi.fn(async () => ({
      pendingActivities: 0,
      pendingUsers: 0,
      projectedUsers: 0,
    }));
    const runDbt = vi.fn(async () => 1);
    const recordRun = vi.fn(async () => ({ datasets: 1, failed: 1 }));
    await expect(
      runAnalyticsBuild({
        selectedModels: selected,
        artifactDirectory: "/tmp/input-failure",
        microbatchBounds: TEST_MICROBATCH_BOUNDS,
        loadPendingDatasets: async () => [],
        runDbt,
        recordRun,
        projectCyclingPower,
        readArtifact: createArtifactReader(
          "input-failure",
          selected.map((model) => ({
            uniqueId: `model.dofek.${model}`,
            name: model,
            status: model === "activity_summary_rows" ? "error" : "skipped",
            executionTime: 1,
            message: "Input failed",
          })),
        ),
      }),
    ).rejects.toBeInstanceOf(AnalyticsBuildError);
    expect(runDbt).toHaveBeenCalledOnce();
    expect(projectCyclingPower).not.toHaveBeenCalled();
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        modelResults: [
          expect.objectContaining({ name: "activity_summary_rows", status: "failed" }),
          expect.objectContaining({ name: "healthspan_activity_zone_minutes", status: "skipped" }),
          expect.objectContaining({ name: "weekly_healthspan", status: "skipped" }),
        ],
      }),
    );
  });

  it("drains activity and user batches before downstream builds and processing success", async () => {
    const order: string[] = [];
    const batches = [
      { pendingActivities: 174, pendingUsers: 34, projectedUsers: 0 },
      { pendingActivities: 74, pendingUsers: 34, projectedUsers: 0 },
      { pendingActivities: 0, pendingUsers: 2, projectedUsers: 32 },
      { pendingActivities: 0, pendingUsers: 0, projectedUsers: 2 },
    ];
    const selected = ["activity_summary_rows", "weekly_healthspan"];
    const result = await runAnalyticsBuild({
      selectedModels: selected,
      artifactDirectory: "/tmp/cycling-projection-batches",
      microbatchBounds: TEST_MICROBATCH_BOUNDS,
      loadPendingDatasets: async () => [],
      runDbt: async (args) => {
        order.push(`dbt:${args.at(-1)}`);
        return 0;
      },
      readArtifact: createArtifactReader(
        "cycling-batches",
        selected.map((name) => ({
          uniqueId: `model.dofek.${name}`,
          name,
          status: "success",
          executionTime: 1,
          message: null,
        })),
      ),
      projectCyclingPower: async () => {
        const batch = batches.shift();
        if (!batch) throw new Error("Projection ran after the backlog was drained");
        order.push(`project:${batch.pendingActivities}:${batch.pendingUsers}`);
        return batch;
      },
      recordRun: async () => {
        order.push("record");
        return { datasets: 1, failed: 0 };
      },
    });
    expect(result).toEqual({ datasets: 1, failed: 0 });
    expect(order).toEqual([
      "dbt:activity_summary_rows",
      "project:174:34",
      "project:74:34",
      "project:0:2",
      "project:0:0",
      "dbt:weekly_healthspan",
      "record",
    ]);
  });

  it("keeps one projection instant when batches cross UTC midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T23:59:59Z"));
    const instants: Array<string | null> = [];
    try {
      await runAnalyticsBuild({
        selectedModels: ["cycling_activity"],
        artifactDirectory: "/tmp/cycling-projection-midnight",
        microbatchBounds: TEST_MICROBATCH_BOUNDS,
        loadPendingDatasets: async () => [],
        runDbt: async () => 0,
        readArtifact: createArtifactReader("midnight", [
          {
            uniqueId: "model.dofek.cycling_activity",
            name: "cycling_activity",
            status: "success",
            executionTime: 1,
            message: null,
          },
        ]),
        projectCyclingPower: async (asOf: Date) => {
          instants.push(asOf?.toISOString() ?? null);
          vi.setSystemTime(new Date("2026-11-03T00:00:01Z"));
          return {
            pendingActivities: 0,
            pendingUsers: instants.length === 1 ? 1 : 0,
            projectedUsers: 32,
          };
        },
        recordRun: async () => ({ datasets: 1, failed: 0 }),
      });
      expect(instants).toEqual(["2026-11-02T23:59:59.000Z", "2026-11-02T23:59:59.000Z"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("withholds processing success when cycling projection stops making progress", async () => {
    const recordRun = vi.fn(async () => ({ datasets: 1, failed: 0 }));
    const runDbt = vi.fn(async () => 0);
    let batches = 0;
    await expect(
      runAnalyticsBuild({
        selectedModels: ["cycling_activity", "weekly_healthspan"],
        artifactDirectory: "/tmp/cycling-projection-gate",
        microbatchBounds: TEST_MICROBATCH_BOUNDS,
        loadPendingDatasets: async () => [],
        runDbt,
        readArtifact: createArtifactReader("cycling-run", [
          {
            uniqueId: "model.dofek.cycling_activity",
            name: "cycling_activity",
            status: "success",
            executionTime: 1,
            message: null,
          },
        ]),
        projectCyclingPower: async () => {
          if (++batches > 2) throw new Error("Repeated a stalled projection");
          return { pendingActivities: 1, pendingUsers: 1, projectedUsers: 0 };
        },
        recordRun,
      }),
    ).rejects.toThrow("Cycling power projection made no progress: 1 activities and 1 users remain");
    expect(batches).toBe(2);
    expect(runDbt).toHaveBeenCalledOnce();
    expect(recordRun).not.toHaveBeenCalled();
  });

  it("snapshots pending operations before starting dbt so later updates need another build", async () => {
    const pending: Array<{ operationId: string; datasetKey: "providers" }> = [
      { operationId: "30000000-0000-4000-8000-000000000001", datasetKey: "providers" },
    ];
    const recordRun = vi.fn(async () => ({ datasets: 1, failed: 0 }));
    await runAnalyticsBuild({
      projectCyclingPower: async () => ({
        pendingActivities: 0,
        pendingUsers: 0,
        projectedUsers: 0,
      }),
      selectedModels: ["provider_stats"],
      artifactDirectory: "/tmp/dofek-dbt-snapshot",
      microbatchBounds: TEST_MICROBATCH_BOUNDS,
      loadPendingDatasets: async () => [...pending],
      runDbt: async () => {
        pending.push({
          operationId: "30000000-0000-4000-8000-000000000002",
          datasetKey: "providers",
        });
        return 0;
      },
      readArtifact: createArtifactReader("snapshot-run", [
        {
          uniqueId: "model.dofek.provider_stats",
          name: "provider_stats",
          status: "success",
          executionTime: 1,
          message: null,
        },
      ]),
      recordRun,
    });
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingDatasets: [pending[0]],
      }),
    );
  });

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
        projectCyclingPower: async () => ({
          pendingActivities: 0,
          pendingUsers: 0,
          projectedUsers: 0,
        }),
        loadPendingDatasets: async () => [],
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
      '{"sensor_scalar_sample_begin":"2025-02-03","deduped_sensor_begin":"2025-02-03","activity_sensor_sample_begin":"2025-02-03"}',
      "--select",
      "provider_stats",
    ]);
    expect(recordRun).toHaveBeenCalledWith({
      runId: "dbt-run-1",
      pendingDatasets: [],
      modelResults: [expect.objectContaining({ name: "provider_stats", status: "succeeded" })],
    });
  });

  it("records failing artifacts and then fails the command", async () => {
    const recordRun = vi.fn(async () => ({ datasets: 1, failed: 1 }));

    await expect(
      runAnalyticsBuild({
        projectCyclingPower: async () => ({
          pendingActivities: 0,
          pendingUsers: 0,
          projectedUsers: 0,
        }),
        loadPendingDatasets: async () => [],
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

  it("reports a missing dbt artifact as an analytics build failure", async () => {
    const artifactError = Object.assign(new Error("no such file or directory"), {
      code: "ENOENT",
    });
    const recordRun = vi.fn(async () => ({ datasets: 1, failed: 0 }));

    await expect(
      runAnalyticsBuild({
        projectCyclingPower: async () => ({
          pendingActivities: 0,
          pendingUsers: 0,
          projectedUsers: 0,
        }),
        loadPendingDatasets: async () => [],
        selectedModels: ["provider_stats"],
        artifactDirectory: "/tmp/dofek-dbt-test",
        microbatchBounds: TEST_MICROBATCH_BOUNDS,
        runDbt: async () => 1,
        readArtifact: async () => {
          throw artifactError;
        },
        recordRun,
      }),
    ).rejects.toMatchObject({
      constructor: AnalyticsBuildError,
      exitCode: 1,
      reason: "process-failed",
      failures: [
        {
          modelName: "dbt",
          status: "failed",
          errorCode: "dbt_artifact_missing",
          message: "dbt did not produce manifest.json",
          category: "unknown",
        },
      ],
    });

    expect(recordRun).not.toHaveBeenCalled();
  });

  it("reports a missing run-results artifact as an analytics build failure", async () => {
    const artifactError = Object.assign(new Error("no such file or directory"), {
      code: "ENOENT",
    });
    const recordRun = vi.fn(async () => ({ datasets: 1, failed: 0 }));
    const readArtifact = vi.fn(async (name: "manifest.json" | "run_results.json") => {
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
      throw artifactError;
    });

    await expect(
      runAnalyticsBuild({
        projectCyclingPower: async () => ({
          pendingActivities: 0,
          pendingUsers: 0,
          projectedUsers: 0,
        }),
        loadPendingDatasets: async () => [],
        selectedModels: ["provider_stats"],
        artifactDirectory: "/tmp/dofek-dbt-test",
        microbatchBounds: TEST_MICROBATCH_BOUNDS,
        runDbt: async () => 1,
        readArtifact,
        recordRun,
      }),
    ).rejects.toMatchObject({
      constructor: AnalyticsBuildError,
      exitCode: 1,
      reason: "process-failed",
      failures: [
        {
          modelName: "dbt",
          status: "failed",
          errorCode: "dbt_artifact_missing",
          message: "dbt did not produce run_results.json",
          category: "unknown",
        },
      ],
    });

    expect(readArtifact).toHaveBeenNthCalledWith(1, "manifest.json");
    expect(readArtifact).toHaveBeenNthCalledWith(2, "run_results.json");
    expect(recordRun).not.toHaveBeenCalled();
  });

  it("preserves processing failures when dbt artifacts are incomplete", async () => {
    const recordRun = vi.fn(async () => ({ datasets: 1, failed: 2 }));

    await expect(
      runAnalyticsBuild({
        projectCyclingPower: async () => ({
          pendingActivities: 0,
          pendingUsers: 0,
          projectedUsers: 0,
        }),
        loadPendingDatasets: async () => [],
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
        projectCyclingPower: async () => ({
          pendingActivities: 0,
          pendingUsers: 0,
          projectedUsers: 0,
        }),
        loadPendingDatasets: async () => [],
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

    const error = await runAnalyticsBuild({
      projectCyclingPower: async () => ({
        pendingActivities: 0,
        pendingUsers: 0,
        projectedUsers: 0,
      }),
      loadPendingDatasets: async () => [],
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
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AnalyticsBuildError);
    if (error instanceof AnalyticsBuildError) {
      expect(error.failures).toEqual([
        {
          modelName: "provider_stats",
          status: "failed",
          errorCode: "dbt_model_failed",
          message: "Code: 159 TIMEOUT_EXCEEDED",
          category: "timeout",
        },
      ]);
    }

    await expect(
      runAnalyticsBuild({
        projectCyclingPower: async () => ({
          pendingActivities: 0,
          pendingUsers: 0,
          projectedUsers: 0,
        }),
        loadPendingDatasets: async () => [],
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
