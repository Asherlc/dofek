import { describe, expect, it, vi } from "vitest";
import { runAnalyticsBuild } from "./run-analytics-build.ts";

describe("runAnalyticsBuild", () => {
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
    ).rejects.toThrow("dbt build failed with exit code 1");

    expect(recordRun).toHaveBeenCalledOnce();
  });
});
