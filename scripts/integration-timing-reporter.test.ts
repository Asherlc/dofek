import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVitest, type RunnerTestFile, type Vitest } from "vitest/node";
import IntegrationTestSequencer from "./integration-test-sequencer.ts";
import IntegrationTimingReporter from "./integration-timing-reporter.ts";
import { runIntegrationTimingCommand } from "./update-integration-test-timings.ts";

const roots: string[] = [];
const contexts: Vitest[] = [];
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
const provenance = {
  sourceSha: "a".repeat(40),
  repository: "owner/repo",
  runId: 123,
  runAttempt: 2,
  vitestVersion: "5.0.5",
  source: "fixture",
};
const environment = {
  GITHUB_ACTIONS: "true",
  GITHUB_SHA: provenance.sourceSha,
  GITHUB_REPOSITORY: provenance.repository,
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "2",
  GITHUB_EVENT_NAME: "push",
};
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function rootFixture() {
  const root = mkdtempSync(join(tmpdir(), "integration-timing-reporter-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "scripts/integration-test-timings.json"),
    JSON.stringify({
      schemaVersion: 1,
      provenance,
      files: [0, 1, 2, 3].map((i) => ({
        project: "integration",
        file: `src/${i}.integration.test.ts`,
        durationMs: 10,
      })),
    }),
  );
  return root;
}
async function fixture() {
  const root = rootFixture();
  const context = await createVitest(
    "test",
    { root, config: false, watch: false, name: "integration", pool: "forks", shard: "1/4" },
    { server: { middlewareMode: true } },
  );
  contexts.push(context);
  const specs = [0, 1, 2, 3].map((i) =>
    context.getRootProject().createSpecification(join(root, `src/${i}.integration.test.ts`)),
  );
  const reporter = new IntegrationTimingReporter();
  reporter.onInit(context);
  reporter.onTestRunStart(specs);
  const selected = await new IntegrationTestSequencer(context).shard(specs);
  const completed = { duration: 25, failed: false, lastRun: Date.now() };
  vi.spyOn(context.cache, "getTestSpecificationResult").mockReturnValue(completed);
  const modules = selected.map((spec, index) => {
    const file: RunnerTestFile = {
      id: String(index),
      name: spec.moduleId,
      fullName: spec.moduleId,
      type: "suite",
      filepath: spec.moduleId,
      projectName: "integration",
      pool: "forks",
      mode: "run",
      meta: {},
      tasks: [],
      concurrencyId: 1,
      workerId: 1,
      result: { state: "pass" },
      get file() {
        return file;
      },
    };
    context.state.collectFiles(spec.project, [file]);
    const module = context.state.getReportedEntity(file);
    if (module?.type !== "module") throw new Error("Missing fixture module");
    return module;
  });
  const directory = join(root, "reports/integration-sharding/1-of-4");
  return { root, directory, context, reporter, selected, completed, modules };
}
describe("integration timing reporter", () => {
  it("captures complete current-run public cache results after successful execution", async () => {
    const setup = await fixture();
    setup.reporter.onTestRunEnd(setup.modules, [], "passed");
    const artifact = JSON.parse(
      readFileSync(join(setup.directory, "completed-results.json"), "utf8"),
    );
    expect(artifact.results).toEqual([["integration:src/0.integration.test.ts", setup.completed]]);
    expect(artifact.assignmentId).toBe(
      JSON.parse(readFileSync(join(setup.directory, "assignment.json"), "utf8")).assignmentId,
    );
    expect(artifact.runStartedAt).toBeLessThanOrEqual(setup.completed.lastRun);
    expect(artifact.runFinishedAt).toBeGreaterThanOrEqual(setup.completed.lastRun);
  });
  it.each([
    "failed",
    "interrupted",
    "errors",
    "failed-module",
    "missing",
    "extra",
    "duplicate",
    "partial",
    "stale",
    "duration",
    "missing-cache",
  ])("rejects %s completion", async (kind) => {
    const setup = await fixture();
    let modules = setup.modules;
    if (kind === "failed-module") vi.spyOn(required(modules[0]), "ok").mockReturnValue(false);
    if (kind === "missing") modules = [];
    if (kind === "extra" || kind === "duplicate") modules = [...modules, ...modules];
    if (kind === "partial") Reflect.deleteProperty(setup.completed, "lastRun");
    if (kind === "stale") setup.completed.lastRun = 1;
    if (kind === "duration") setup.completed.duration = Number.POSITIVE_INFINITY;
    if (kind === "missing-cache")
      vi.spyOn(setup.context.cache, "getTestSpecificationResult").mockReturnValue(undefined);
    const end = () =>
      setup.reporter.onTestRunEnd(
        modules,
        kind === "errors" ? [{ name: "Error", message: "unhandled" }] : [],
        kind === "failed" || kind === "interrupted" ? kind : "passed",
      );
    if (["failed", "interrupted", "errors", "partial", "stale", "missing-cache"].includes(kind))
      expect(end).not.toThrow();
    else expect(end).toThrow();
    expect(existsSync(join(setup.directory, "completed-results.json"))).toBe(false);
  });
  it("does not activate for unsharded runs", async () => {
    const setup = await fixture();
    setup.context.config.shard = undefined;
    const reporter = new IntegrationTimingReporter();
    reporter.onInit(setup.context);
    reporter.onTestRunStart(setup.selected);
    expect(() => reporter.onTestRunEnd([], [], "passed")).not.toThrow();
    expect(existsSync(join(setup.directory, "completed-results.json"))).toBe(false);
  });
});

function runnerFixture(index: number, body = "expect(1).toBe(1)") {
  const root = rootFixture();
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
  for (const i of [0, 1, 2, 3])
    writeFileSync(
      join(root, `src/${i}.integration.test.ts`),
      `import { test, expect } from 'vitest'; test('kept', () => { ${body} }); test('other', () => expect(2).toBe(2));`,
    );
  writeFileSync(
    join(root, "vitest.config.ts"),
    `
import { defineConfig } from 'vitest/config';
import Sequencer from ${JSON.stringify(resolve("scripts/integration-test-sequencer.ts"))};
import Reporter from ${JSON.stringify(resolve("scripts/integration-timing-reporter.ts"))};
export default defineConfig({ cacheDir: ${JSON.stringify(join(root, ".vitest-cache"))}, test: { name: 'integration', include: ['src/*.integration.test.ts'], pool: 'forks', fileParallelism: false, maxWorkers: 1, sequence: { sequencer: Sequencer }, reporters: ['default', new Reporter()] } });`,
  );
  const run = (extra: string[] = [], sharded = true) =>
    spawnSync(
      process.execPath,
      [
        resolve("node_modules/vitest/vitest.mjs"),
        "run",
        "--root",
        root,
        "--config",
        join(root, "vitest.config.ts"),
        ...(sharded ? ["--shard", `${index}/4`] : []),
        ...extra,
      ],
      { cwd: root, env: { ...process.env, ...environment }, encoding: "utf8" },
    );
  return { root, run, directory: join(root, `reports/integration-sharding/${index}-of-4`) };
}
describe("real Vitest public timing lifecycle", () => {
  it("runs unsharded without a timing baseline or timing artifacts", () => {
    const shard = runnerFixture(1);
    rmSync(join(shard.root, "scripts/integration-test-timings.json"));
    const run = shard.run([], false);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(existsSync(join(shard.root, "reports/integration-sharding"))).toBe(false);
  });
  it("exports and merges four fresh child runners, while a warm run stays ineligible for export", () => {
    const shards = [1, 2, 3, 4].map((index) => runnerFixture(index));
    for (const shard of shards) {
      const run = shard.run();
      expect(run.status, run.stdout + run.stderr).toBe(0);
      runIntegrationTimingCommand(["export", shard.directory], environment);
    }
    const first = required(shards[0]);
    const output = join(first.root, "merged.json");
    runIntegrationTimingCommand(
      ["merge", output, ...shards.map((shard) => shard.directory)],
      environment,
    );
    const baseline = JSON.parse(readFileSync(output, "utf8"));
    expect(baseline.files).toHaveLength(4);
    expect(
      baseline.files.every(
        (row: { durationMs: number }) => Number.isFinite(row.durationMs) && row.durationMs >= 0,
      ),
    ).toBe(true);
    const warm = first.run();
    expect(warm.status, warm.stdout + warm.stderr).toBe(0);
    expect(existsSync(join(first.directory, "completed-results.json"))).toBe(false);
    expect(() => runIntegrationTimingCommand(["export", first.directory], environment)).toThrow(
      /stale|preexisting/i,
    );
  });
  it("preserves ordinary sharded execution with the cache disabled but rejects timing export", () => {
    const shard = runnerFixture(1);
    const run = shard.run(["--no-cache"]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(existsSync(join(shard.directory, "completed-results.json"))).toBe(false);
    expect(() => runIntegrationTimingCommand(["export", shard.directory], environment)).toThrow(
      /disabled/i,
    );
  });
  it.each(["failed", "partial"])("rejects an actual %s child run", (kind) => {
    const shard = runnerFixture(1, kind === "failed" ? "expect(1).toBe(2)" : undefined);
    const run = shard.run(kind === "partial" ? ["-t", "kept"] : []);
    expect(run.status, run.stdout + run.stderr).toBe(kind === "partial" ? 0 : 1);
    expect(existsSync(join(shard.directory, "completed-results.json"))).toBe(false);
    expect(() => runIntegrationTimingCommand(["export", shard.directory], environment)).toThrow(
      /no eligible complete timing results/i,
    );
  });
});
