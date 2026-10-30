import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseSequencer, createVitest, type Vitest } from "vitest/node";
import IntegrationTestSequencer from "./integration-test-sequencer.ts";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
const roots: string[] = [];
const contexts: Vitest[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
  roots.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function fixture(durations: number[] = [90, 80, 70, 60, 10, 10, 10, 10]) {
  const root = mkdtempSync(join(tmpdir(), "integration-sequencer-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  const files = durations.map((durationMs, i) => ({
    project: "integration",
    file: `src/${i}.integration.test.ts`,
    durationMs,
  }));
  writeFileSync(
    join(root, "scripts/integration-test-timings.json"),
    JSON.stringify({
      schemaVersion: 1,
      provenance: {
        vitestVersion: "4.1.11",
        sourceSha: "a".repeat(40),
        repository: "owner/repo",
        runId: 1,
        runAttempt: 1,
        source: "fixture",
      },
      files,
    }),
  );
  const context = await createVitest(
    "test",
    { root, config: false, watch: false, name: "integration", pool: "forks" },
    { server: { middlewareMode: true } },
  );
  contexts.push(context);

  const makeSpec = (file: string, name = "integration", pool = "forks") => {
    const project = context.getRootProject();
    const specification = project.createSpecification(
      join(root, file),
      { testLines: [7], testNamePattern: /keep/ },
      pool,
    );
    if (name !== "integration")
      vi.spyOn(specification.project, "name", "get").mockReturnValue(name);
    return specification;
  };
  const specs = files.map((row) => makeSpec(row.file));
  const shard = (index = 1, count = 4, input = specs) => {
    context.config.shard = { index, count };
    return new IntegrationTestSequencer(context).shard(input);
  };
  const manifest = (index = 1, count = 4) =>
    JSON.parse(
      readFileSync(
        join(root, `reports/integration-sharding/${index}-of-${count}/assignment.json`),
        "utf8",
      ),
    );
  return { root, specs, context, shard, manifest, makeSpec };
}
describe("duration balanced integration sequencing", () => {
  it("consumes historical runner weights and records the actual current runtime without relabeling measurements", async () => {
    const setup = await fixture();
    const baselinePath = join(setup.root, "scripts/integration-test-timings.json");
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    baseline.provenance.vitestVersion = "4.1.10";
    const historicalBytes = JSON.stringify(baseline);
    writeFileSync(baselinePath, historicalBytes);
    expect(setup.context.version).not.toBe(baseline.provenance.vitestVersion);
    const bins = await Promise.all([1, 2, 3, 4].map((index) => setup.shard(index)));
    expect(bins.flat()).toHaveLength(setup.specs.length);
    for (const specification of setup.specs)
      expect(bins.flat().filter((selected) => selected === specification)).toHaveLength(1);
    for (const index of [1, 2, 3, 4])
      expect(setup.manifest(index).provenance.vitestVersion).toBe(setup.context.version);
    expect(setup.manifest().bins.map((bin: { durationMs: number }) => bin.durationMs)).toEqual([
      90, 90, 80, 80,
    ]);
    expect(readFileSync(baselinePath, "utf8")).toBe(historicalBytes);
  });
  it("records the checked-out pull-request head source instead of the Actions merge SHA", async () => {
    const setup = await fixture();
    const eventPath = join(setup.root, "event.json");
    writeFileSync(eventPath, JSON.stringify({ pull_request: { head: { sha: "a".repeat(40) } } }));
    vi.stubEnv("GITHUB_EVENT_NAME", "pull_request");
    vi.stubEnv("GITHUB_EVENT_PATH", eventPath);
    vi.stubEnv("GITHUB_SHA", "b".repeat(40));
    await setup.shard();
    expect(setup.manifest().provenance.sourceSha).toBe("a".repeat(40));
  });
  it("reduces skew and partitions exact original specifications with selectors", async () => {
    const setup = await fixture();
    const bins = await Promise.all([1, 2, 3, 4].map((i) => setup.shard(i)));
    expect(bins.flat()).toHaveLength(setup.specs.length);
    for (const spec of setup.specs) expect(bins.flat().filter((x) => x === spec)).toHaveLength(1);
    expect(
      Math.max(...setup.manifest().bins.map((b: { durationMs: number }) => b.durationMs)),
    ).toBe(90);
    expect(setup.manifest().bins.map((b: { fileCount: number }) => b.fileCount)).toEqual([
      1, 2, 2, 3,
    ]);
    expect(
      Math.max(...setup.manifest().bins.map((bin: { durationMs: number }) => bin.durationMs)),
    ).toBeLessThan(170);
    expect(bins.flat()[0]?.testLines).toEqual([7]);
  });
  it("is independent of checkout root, discovery order and preexisting cache", async () => {
    const a = await fixture(),
      b = await fixture();
    vi.spyOn(b.context.cache, "getTestSpecificationResult").mockReturnValue({
      duration: 100,
      failed: false,
      lastRun: Date.now() - 1000,
    });
    for (const index of [1, 2, 3, 4]) {
      await a.shard(index);
      await b.shard(index, 4, [...b.specs].reverse());
      expect(a.manifest(index).selected).toEqual(b.manifest(index).selected);
      expect(a.manifest(index).baselineSha256).toBe(b.manifest(index).baselineSha256);
    }
    expect(b.manifest().cacheExistedBefore).toBe(true);
  });
  it("records disabled caches and replaces stale app-owned results for a new assignment", async () => {
    const setup = await fixture();
    await setup.shard();
    const first = setup.manifest();
    const directory = join(setup.root, "reports/integration-sharding/1-of-4");
    writeFileSync(join(directory, "completed-results.json"), "old completion");
    writeFileSync(join(directory, "results.json"), "old export");
    setup.context.config.cache = false;
    await setup.shard();
    expect(setup.manifest().assignmentId).not.toBe(first.assignmentId);
    expect(setup.manifest().cacheEnabled).toBe(false);
    expect(() => readFileSync(join(directory, "completed-results.json"))).toThrow();
    expect(() => readFileSync(join(directory, "results.json"))).toThrow();
  });
  it("uses ordinal ties, zero weights, and empty bins when shards exceed files", async () => {
    const setup = await fixture([10, 10, 0, 0]);
    await Promise.all([1, 2, 3, 4, 5].map((i) => setup.shard(i, 5)));
    expect([1, 2, 3, 4, 5].map((i) => setup.manifest(i, 5).selected.length)).toEqual([
      1, 1, 1, 1, 0,
    ]);
    expect(setup.manifest(1, 5).selected).toEqual(["integration:src/0.integration.test.ts"]);
  });
  it("estimates new files using positive median, reports them and ignores removed rows", async () => {
    const setup = await fixture([0, 10, 30]);
    const added = setup.makeSpec("src/new.integration.test.ts");
    await setup.shard(1, 1, [required(setup.specs[0]), added]);
    expect(setup.manifest(1, 1).estimated).toEqual(["integration:src/new.integration.test.ts"]);
    expect(setup.manifest(1, 1).bins[0].durationMs).toBe(20);
    expect(setup.manifest(1, 1).inventory).toHaveLength(2);
  });
  it("delegates mixed and other projects to BaseSequencer", async () => {
    const setup = await fixture();
    const delegate = vi.spyOn(BaseSequencer.prototype, "shard").mockResolvedValue(setup.specs);
    const other = setup.makeSpec("src/unit.ts", "unit");
    expect(await setup.shard(1, 4, [other])).toBe(setup.specs);
    expect(await setup.shard(1, 4, [other, ...setup.specs])).toBe(setup.specs);
    expect(delegate).toHaveBeenCalledTimes(2);
  });
  it.each([
    [0, 4],
    [5, 4],
    [1, 0],
    [1.5, 4],
    [1, 2.5],
  ])("rejects invalid shard %s/%s", async (index, count) => {
    await expect((await fixture()).shard(index, count)).rejects.toThrow(/shard/i);
  });
  it("rejects duplicate and unsupported specification identities", async () => {
    const setup = await fixture();
    await expect(
      setup.shard(1, 4, [required(setup.specs[0]), required(setup.specs[0])]),
    ).rejects.toThrow(/duplicate/i);
    await expect(
      setup.shard(1, 4, [setup.makeSpec("src/other.ts", "integration", "threads")]),
    ).rejects.toThrow(/pool/i);
    await expect(setup.shard(1, 4, [setup.makeSpec("../outside.ts")])).rejects.toThrow(/identity/i);
  });
  it.each([
    "missing",
    "{}",
    "{",
    JSON.stringify({ schemaVersion: 1, files: [] }),
    "negative",
    "zero",
    "duplicate",
    "nonfinite",
  ])("fails loudly on %s baseline", async (kind) => {
    const setup = await fixture();
    const file = join(setup.root, "scripts/integration-test-timings.json");
    if (kind === "missing") rmSync(file);
    else if (["negative", "zero", "duplicate", "nonfinite"].includes(kind)) {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (kind === "duplicate") data.files.push(data.files[0]);
      else for (const row of data.files) row.durationMs = kind === "zero" ? 0 : -1;
      writeFileSync(
        file,
        kind === "nonfinite" ? JSON.stringify(data).replace(/-1/g, "1e999") : JSON.stringify(data),
      );
    } else writeFileSync(file, kind);
    await expect(setup.shard()).rejects.toThrow(/integration timing baseline[\s\S]*refresh/);
  });
});
