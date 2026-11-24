import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOwnedDbtBuild } from "./dbt-build.ts";

const mockLoggerInfo = vi.fn();
vi.mock("../logger.ts", () => ({
  logger: { info: (...args: unknown[]) => mockLoggerInfo(...args) },
}));
vi.mock("../lib/error-reporting.ts", () => ({ captureException: vi.fn() }));
describe("owned dbt artifacts", () => {
  let directory: string;
  beforeEach(async () => {
    mockLoggerInfo.mockClear();
    directory = await mkdtemp(join(tmpdir(), "owned-dbt-unit-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const owner = {
    runSynchronousDbt: vi.fn(async (operation: () => Promise<number>) => {
      const code = await operation();
      if (code !== 0) throw new Error("dbt did not complete");
      return code;
    }),
  };
  function modelTimingCalls() {
    return mockLoggerInfo.mock.calls.filter(([event]) => event === "analytics.dbt_model");
  }
  async function writeArtifacts(
    models: ReadonlyArray<{ name: string; status: string; executionTime: number }>,
  ) {
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        metadata: { dbt_schema_version: "https://schemas.getdbt.com/dbt/manifest/v12.json" },
        nodes: Object.fromEntries(
          models.map((model) => [
            `model.fixture.${model.name}`,
            {
              unique_id: `model.fixture.${model.name}`,
              name: model.name,
              resource_type: "model",
            },
          ]),
        ),
      }),
    );
    await writeFile(
      join(directory, "run_results.json"),
      JSON.stringify({
        metadata: { invocation_id: "fixture" },
        results: models.map((model) => ({
          unique_id: `model.fixture.${model.name}`,
          status: model.status,
          execution_time: model.executionTime,
          message: null,
        })),
      }),
    );
  }
  async function artifacts(status = "success", executionTime = 1) {
    await writeArtifacts([{ name: "rows", status, executionTime }]);
  }
  it("keeps artifact validation inside registered child work", async () => {
    let registered = false;
    owner.runSynchronousDbt.mockImplementationOnce(async (operation) => {
      registered = true;
      const code = await operation();
      expect(
        JSON.parse(await readFile(join(directory, "run_results.json"), "utf8")).results,
      ).toHaveLength(1);
      return code;
    });
    await expect(
      runOwnedDbtBuild(owner, directory, ["rows"], async () => {
        expect(registered).toBe(true);
        await artifacts();
        return 0;
      }),
    ).resolves.toBe(0);
  });
  it("cannot reuse an earlier successful artifact", async () => {
    await artifacts();
    await expect(runOwnedDbtBuild(owner, directory, ["rows"], async () => 0)).rejects.toThrow(
      "ENOENT",
    );
  });
  it("requires this child to produce a new manifest as well as run results", async () => {
    await artifacts();
    const results = await readFile(join(directory, "run_results.json"), "utf8");
    await expect(
      runOwnedDbtBuild(owner, directory, ["rows"], async () => {
        await writeFile(join(directory, "run_results.json"), results);
        return 0;
      }),
    ).rejects.toThrow("ENOENT");
  });
  it.each(["error", "skipped"])("rejects a zero exit with %s artifacts", async (status) => {
    await expect(
      runOwnedDbtBuild(owner, directory, ["rows"], async () => {
        await artifacts(status);
        return 0;
      }),
    ).rejects.toThrow("incomplete");
    expect(modelTimingCalls()).toEqual([]);
  });
  it("preserves a nonzero exit for existing build failure reporting", async () => {
    await expect(runOwnedDbtBuild(owner, directory, ["rows"], async () => 7)).resolves.toBe(7);
    expect(modelTimingCalls()).toEqual([]);
  });
  it("emits one analytics.dbt_model timing per model after a valid fresh artifact", async () => {
    await expect(
      runOwnedDbtBuild(owner, directory, ["rows", "sleep"], async () => {
        await writeArtifacts([
          { name: "rows", status: "success", executionTime: 1.2506 },
          { name: "sleep", status: "success", executionTime: 0.5 },
        ]);
        return 0;
      }),
    ).resolves.toBe(0);
    expect(modelTimingCalls()).toEqual([
      ["analytics.dbt_model", { model: "rows", duration_ms: 1251 }],
      ["analytics.dbt_model", { model: "sleep", duration_ms: 500 }],
    ]);
  });
  it("emits no timings for a partially incomplete two-model artifact", async () => {
    await expect(
      runOwnedDbtBuild(owner, directory, ["rows", "sleep"], async () => {
        await writeArtifacts([
          { name: "rows", status: "success", executionTime: 1.2504 },
          { name: "sleep", status: "skipped", executionTime: 0.5 },
        ]);
        return 0;
      }),
    ).rejects.toThrow("incomplete");
    expect(modelTimingCalls()).toEqual([]);
  });
  it("does not emit timings when the owner rejects after a successful callback", async () => {
    const rejection = new Error("owner rejected after admission");
    owner.runSynchronousDbt.mockImplementationOnce(async (operation) => {
      await operation();
      throw rejection;
    });
    await expect(
      runOwnedDbtBuild(owner, directory, ["rows"], async () => {
        await artifacts("success", 1.2504);
        return 0;
      }),
    ).rejects.toBe(rejection);
    expect(modelTimingCalls()).toEqual([]);
  });
  it("propagates spawn errors and does not call them a terminal success", async () => {
    const error = new Error("spawn failed");
    await expect(
      runOwnedDbtBuild(owner, directory, ["rows"], async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(modelTimingCalls()).toEqual([]);
  });
});
