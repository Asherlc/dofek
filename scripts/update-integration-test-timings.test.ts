import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIntegrationTimingCommand } from "./update-integration-test-timings.ts";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
type MutableEvidence = {
  assignmentId: string;
  assignedAt: number;
  runStartedAt: number;
  runFinishedAt: number;
  cacheEnabled: boolean;
  cacheExistedBefore: boolean;
  baselineSha256: string;
  inventory: string[];
  provenance: Record<string, string | number>;
  results: [string, { duration: number; failed: boolean; lastRun?: number }][];
  selected: string[];
};
const roots: string[] = [];
afterEach(() =>
  roots.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  }),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "integration-timings-"));
  roots.push(root);
  const provenance = {
    sourceSha: "a".repeat(40),
    repository: "owner/repo",
    runId: 123,
    runAttempt: 2,
    vitestVersion: "5.0.5",
    source: "Vitest results cache",
  };
  const environment = {
    GITHUB_ACTIONS: "true",
    GITHUB_SHA: provenance.sourceSha,
    GITHUB_REPOSITORY: provenance.repository,
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
  };
  const inventory = [0, 1, 2, 3].map((i) => `integration:src/${i}.integration.test.ts`);
  const directories = inventory.map((key, i) => {
    const directory = join(root, String(i));
    mkdirSync(directory);
    const assignmentId = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    writeFileSync(
      join(directory, "assignment.json"),
      JSON.stringify({
        schemaVersion: 2,
        assignmentId,
        assignedAt: 1100,
        provenance,
        index: i + 1,
        count: 4,
        inventory,
        selected: [key],
        baselineSha256: "b".repeat(64),
        cacheEnabled: true,
        cacheExistedBefore: false,
        estimated: [],
        bins: inventory.map(() => ({ durationMs: 10, fileCount: 1 })),
      }),
    );
    writeFileSync(
      join(directory, "completed-results.json"),
      JSON.stringify({
        schemaVersion: 1,
        assignmentId,
        provenance,
        index: i + 1,
        count: 4,
        baselineSha256: "b".repeat(64),
        runStartedAt: 1100,
        runFinishedAt: 1200,
        results: [[key, { duration: 10 + i, failed: false, lastRun: 1100 }]],
      }),
    );
    return directory;
  });
  const output = join(root, "baseline.json");
  writeFileSync(output, "old baseline");
  const exportAll = () =>
    directories.forEach((directory) => {
      runIntegrationTimingCommand(["export", directory], environment);
    });
  const merge = () => runIntegrationTimingCommand(["merge", output, ...directories], environment);
  const edit = (index: number, name: string, change: (value: MutableEvidence) => void) => {
    const path = join(required(directories[index]), name);
    const data = JSON.parse(readFileSync(path, "utf8"));
    change(data);
    writeFileSync(path, JSON.stringify(data));
  };
  return { root, provenance, environment, inventory, directories, output, exportAll, merge, edit };
}
describe("integration whole-suite timing export and refresh", () => {
  it("validates the checked-out PR head from existing event context rather than the merge SHA", () => {
    const setup = fixture();
    const eventPath = join(setup.root, "event.json");
    writeFileSync(
      eventPath,
      JSON.stringify({ pull_request: { head: { sha: setup.provenance.sourceSha } } }),
    );
    expect(() =>
      runIntegrationTimingCommand(["export", required(setup.directories[0])], {
        ...setup.environment,
        GITHUB_SHA: "b".repeat(40),
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
      }),
    ).not.toThrow();
  });
  it("exports exact fresh result caches and deterministically refreshes all four complete shards", () => {
    const setup = fixture();
    setup.exportAll();
    setup.merge();
    const data = JSON.parse(readFileSync(setup.output, "utf8"));
    expect(data.files.map((row: { durationMs: number }) => row.durationMs)).toEqual([
      10, 11, 12, 13,
    ]);
    expect(data.files.map((row: { file: string }) => `integration:${row.file}`)).toEqual(
      setup.inventory,
    );
    expect(data.provenance.sourceSha).toBe(setup.provenance.sourceSha);
    expect(data.provenance.shards).toHaveLength(4);
    const first = readFileSync(setup.output, "utf8");
    setup.directories.reverse();
    setup.merge();
    expect(readFileSync(setup.output, "utf8")).toBe(first);
  });
  it.each([
    "stale",
    "missing",
    "failed",
    "foreign",
    "duration",
    "version",
    "duplicate",
    "no-provenance",
    "disabled",
    "old-assignment",
    "partial",
    "old-run",
    "future-run",
    "artifact-provenance",
    "before-assignment",
  ])("rejects %s export without producing an eligible artifact", (kind) => {
    const setup = fixture();
    if (kind === "stale")
      setup.edit(0, "assignment.json", (a) => {
        a.cacheExistedBefore = true;
      });
    else if (kind === "disabled")
      setup.edit(0, "assignment.json", (a) => {
        a.cacheEnabled = false;
      });
    else if (kind === "missing")
      rmSync(join(required(setup.directories[0]), "completed-results.json"));
    else if (kind !== "no-provenance") {
      const path = join(required(setup.directories[0]), "completed-results.json");
      const cache = JSON.parse(readFileSync(path, "utf8"));
      if (kind === "failed") cache.results[0][1].failed = true;
      if (kind === "foreign") cache.results.push(["integration:other.ts", cache.results[0][1]]);
      if (kind === "duration") cache.results[0][1].duration = -1;
      if (kind === "version") cache.schemaVersion = 2;
      if (kind === "duplicate") cache.results.push(cache.results[0]);
      if (kind === "old-assignment") cache.assignmentId = "00000000-0000-4000-8000-999999999999";
      if (kind === "partial") delete cache.results[0][1].lastRun;
      if (kind === "old-run") cache.results[0][1].lastRun = 1099;
      if (kind === "future-run") cache.results[0][1].lastRun = 1201;
      if (kind === "artifact-provenance") cache.provenance.runAttempt = 999;
      if (kind === "before-assignment") cache.runFinishedAt = 1099;
      writeFileSync(path, JSON.stringify(cache));
    }
    expect(() =>
      runIntegrationTimingCommand(
        ["export", required(setup.directories[0])],
        kind === "no-provenance" ? {} : setup.environment,
      ),
    ).toThrow();
    expect(existsSync(join(required(setup.directories[0]), "results.json"))).toBe(false);
  });
  it.each([
    "missing",
    "overlap",
    "duplicate-union",
    "failed",
    "stale",
    "run",
    "attempt",
    "sha",
    "runtime",
    "baseline",
    "inventory",
    "unknown-key",
    "missing-key",
  ])("rejects %s refresh and preserves the old baseline", (kind) => {
    const setup = fixture();
    setup.exportAll();
    if (kind === "missing") setup.directories.pop();
    else if (kind === "overlap") setup.directories[3] = required(setup.directories[0]);
    else if (kind === "duplicate-union") {
      setup.edit(1, "assignment.json", (assignment) => {
        assignment.selected = [required(setup.inventory[0])];
      });
      setup.edit(1, "results.json", (cache) => {
        required(cache.results[0])[0] = required(setup.inventory[0]);
      });
    } else if (kind === "failed")
      setup.edit(0, "results.json", (r) => {
        required(r.results[0])[1].failed = true;
      });
    else if (kind === "stale")
      setup.edit(0, "assignment.json", (a) => {
        a.cacheExistedBefore = true;
      });
    else if (kind === "baseline")
      setup.edit(0, "assignment.json", (a) => {
        a.baselineSha256 = "c".repeat(64);
      });
    else if (kind === "inventory")
      setup.edit(0, "assignment.json", (a) => {
        a.inventory.pop();
      });
    else if (kind === "unknown-key")
      setup.edit(0, "results.json", (r) => {
        required(r.results[0])[0] = "integration:other.ts";
      });
    else if (kind === "missing-key")
      setup.edit(0, "results.json", (r) => {
        r.results = [];
      });
    else
      setup.edit(0, "assignment.json", (a) => {
        const keys: Record<string, string> = {
          run: "runId",
          attempt: "runAttempt",
          sha: "sourceSha",
          runtime: "vitestVersion",
        };
        a.provenance[required(keys[kind])] = kind === "run" || kind === "attempt" ? 999 : "foreign";
      });
    expect(setup.merge).toThrow();
    expect(readFileSync(setup.output, "utf8")).toBe("old baseline");
  });
});
