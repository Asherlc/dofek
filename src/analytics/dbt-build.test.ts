import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOwnedDbtBuild } from "./dbt-build.ts";

vi.mock("../lib/error-reporting.ts", () => ({ captureException: vi.fn() }));
describe("owned dbt artifacts", () => {
  let directory: string;
  beforeEach(async () => {
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
  async function artifacts(status = "success") {
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        metadata: { dbt_schema_version: "https://schemas.getdbt.com/dbt/manifest/v12.json" },
        nodes: {
          "model.fixture.rows": {
            unique_id: "model.fixture.rows",
            name: "rows",
            resource_type: "model",
          },
        },
      }),
    );
    await writeFile(
      join(directory, "run_results.json"),
      JSON.stringify({
        metadata: { invocation_id: "fixture" },
        results: [{ unique_id: "model.fixture.rows", status, execution_time: 1, message: null }],
      }),
    );
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
  });
  it("preserves a nonzero exit for existing build failure reporting", async () => {
    await expect(runOwnedDbtBuild(owner, directory, ["rows"], async () => 7)).resolves.toBe(7);
  });
  it("propagates spawn errors and does not call them a terminal success", async () => {
    const error = new Error("spawn failed");
    await expect(
      runOwnedDbtBuild(owner, directory, ["rows"], async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
});
