import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { hash, mutationFixture, requiredItem } from "./swift-mutation-test-helpers.ts";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));
vi.mock("./swift-mutation-tool.ts", () => ({
  getMutantKitExecutable: () => "mutantkit",
  mutantKitIdentity: {
    toolVersion: "1.3.2",
    toolCommitSHA: "1e345263e36e1658adeed6ae919b7f5875a2601b",
    swiftSyntaxVersion: "604.0.0",
  },
}));
const actualSpawn = (
  await vi.importActual<typeof import("node:child_process")>("node:child_process")
).spawnSync;
const fixtures: string[] = [];
const whoop = "packages/mobile/modules/whoop-ble";
const healthKit = "packages/mobile/modules/health-kit";
interface Invocation {
  tool: string;
  cwd: string;
  args: string[];
}
function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}
function git(root: string, args: string[]) {
  const result = actualSpawn("git", args, { cwd: root, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
function createFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "swift-mutation-test-")));
  fixtures.push(root);
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "Mutation Fixture"]);
  git(root, ["config", "user.email", "mutation@example.test"]);
  write(
    root,
    "packages/mobile/mutantkit.yml",
    "project:\n  kind: swiftPackageMacOS\nreports: [console, json]\nevidence:\n  archive: true\n",
  );
  const inventories = new Map<string, unknown>();
  const calls: Invocation[] = [];
  const state = {
    fail: "",
    exit: 0,
    omit: "",
    malformed: "",
    zero: false,
    candidates: 1,
    duplicateShard: false,
    oversizedFirstPartition: false,
    missing: false,
    stale: false,
    corrupt: false,
    changedAfterRun: false,
    verbose: false,
    verboseExit: 0,
  };
  function addPackage(path: string, target = "ios", sources = ["Parser.swift"]) {
    write(root, `${path}/Package.swift`, "// package\n");
    for (const file of sources) write(root, `${path}/${target}/${file}`, "// source\n");
    write(root, `${path}/ios/ExpoModule.swift`, "// bridge\n");
    write(root, `${path}/Tests/ParserTests.swift`, "// tests\n");
    symlinkSync("../../mutantkit.yml", join(root, path, "mutantkit.yml"));
    inventories.set(join(root, path), {
      targets: [
        { type: "library", module_type: "SwiftTarget", path: target, sources },
        { type: "test", module_type: "SwiftTarget", path: "Tests", sources: ["ParserTests.swift"] },
      ],
    });
  }
  function commitBase() {
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "--allow-empty", "-m", "fixture"]);
    return git(root, ["rev-parse", "HEAD"]);
  }
  function change(path: string) {
    write(root, path, "// changed\n");
  }
  async function run(base: string, options: string[] = []) {
    if (!["--job", "--merge"].includes(options[0] ?? "")) commitBase();
    if (state.missing) rmSync(join(root, whoop, "ios/Parser.swift"));
    vi.resetModules();
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      stdout.push(args.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args) => {
      stderr.push(args.join(" "));
    });
    vi.stubGlobal(
      "process",
      Object.create(process, {
        argv: {
          value: [
            process.execPath,
            "run-swift-mutation.ts",
            ...(["--job", "--merge"].includes(options[0] ?? "")
              ? options
              : ["--base", base, ...options]),
          ],
        },
        cwd: { value: () => root },
        exit: {
          value: (status: number) => {
            throw Object.assign(new Error("command exited"), { status });
          },
        },
      }),
    );
    vi.mocked(spawnSync).mockImplementation((tool, args, opts) => {
      const cwd = String(opts?.cwd ?? root);
      const argv = [...(args ?? [])];
      calls.push({ tool, args: argv, cwd });
      if (tool === "git") return actualSpawn(tool, argv, { cwd, encoding: "utf8" });
      const command = tool === "mutantkit" ? argv[0] : tool;
      const complete = (result: SpawnSyncReturns<string>) => {
        const stdio = opts?.stdio;
        if (Array.isArray(stdio)) {
          if (typeof stdio[1] === "number") writeFileSync(stdio[1], result.stdout ?? "");
          if (typeof stdio[2] === "number") writeFileSync(stdio[2], result.stderr ?? "");
        }
        return result;
      };
      if (state.fail === command)
        return complete({
          status: state.exit,
          pid: 1,
          signal: null,
          output: [],
          stdout: "",
          stderr: `${command} rejected fixture`,
        });
      let output = tool === "swift" ? JSON.stringify(inventories.get(cwd)) : "";
      if (tool === "swift" && state.malformed === "swift") output = "invalid-json";
      if (tool === "swift" && state.malformed === "inventory") output = "{}";
      if (tool === "mutantkit") {
        const outputPath = argv.includes("--output")
          ? requiredItem(argv[argv.indexOf("--output") + 1])
          : "";
        const planPath = argv.includes("--plan")
          ? requiredItem(argv[argv.indexOf("--plan") + 1])
          : "";
        const loadedPlan = planPath ? JSON.parse(readFileSync(planPath, "utf8")) : undefined;
        const selected: string[] = argv.includes("--config")
          ? parse(readFileSync(requiredItem(argv[argv.indexOf("--config") + 1]), "utf8")).sources
              .include
          : [];
        const fixture = mutationFixture(
          cwd,
          Object.fromEntries(
            selected.map((file) => [file, hash(readFileSync(join(cwd, file), "utf8"))]),
          ),
        );
        if (loadedPlan) fixture.plan = loadedPlan;
        const count = fixture.plan.mutations.length;
        fixture.report.results = fixture.plan.mutations.map((point) => ({
          point,
          outcome: "killedByAssertion",
        }));
        for (const key of [
          "discovered",
          "planned",
          "sourceApplied",
          "buildObserved",
          "executed",
          "classified",
          "reported",
        ] as const)
          fixture.report.integrity[key] = count;
        fixture.report.score.killed = count;
        fixture.report.evidenceArchive.entryCount = count;
        fixture.verification.resultCount = count;
        fixture.verification.tierB.reverifiedCount = count;
        fixture.verification.tierB.matchedCount = count;
        fixture.trust.mutationCount = count;
        if (command === "plan") {
          const point = requiredItem(fixture.plan.mutations[0]);
          fixture.plan.mutations = state.zero
            ? []
            : Array.from({ length: state.candidates }, (_, i) => ({ ...point, id: `mut_${i}` }));
          if (state.stale) fixture.plan.sourceFileHashes[requiredItem(selected[0])] = hash("stale");
          if (state.omit !== "plan")
            writeFileSync(
              outputPath,
              state.malformed === "plan" ? "invalid-json" : JSON.stringify(fixture.plan),
            );
        } else if (command === "shard") {
          const parent = JSON.parse(readFileSync(requiredItem(argv[1]), "utf8"));
          const total = Number(argv[argv.indexOf("--count") + 1]);
          const directory = requiredItem(argv[argv.indexOf("--output-directory") + 1]);
          mkdirSync(directory, { recursive: true });
          for (let i = 0; i < total; i++)
            writeFileSync(
              join(directory, `plan.${i}.json`),
              JSON.stringify({
                ...parent,
                mutations: state.duplicateShard
                  ? parent.mutations
                  : parent.mutations.filter((_: unknown, index: number) =>
                      state.oversizedFirstPartition &&
                      total === Math.ceil(parent.mutations.length / 12)
                        ? i === 0
                          ? index < 13
                          : index >= 13 && (index - 13) % (total - 1) === i - 1
                        : index % total === i,
                    ),
              }),
            );
        } else if (command === "verify")
          output = JSON.stringify({
            schemaVersion: 1,
            planID: fixture.plan.planID,
            mutationCount: count,
            valid: true,
            compatibility: "match",
            idViolations: [],
            missingFiles: [],
            anchorViolations: [],
          });
        else if (command === "run") {
          if (state.corrupt) fixture.report.score.killed = 999;
          if (state.omit !== "report")
            writeFileSync(
              outputPath,
              state.malformed === "report" ? "invalid-json" : JSON.stringify(fixture.report),
            );
          if (state.omit !== "archive")
            write(cwd, ".mutantkit/evidence/fixture-run/manifest.json", "{}");
          if (state.changedAfterRun) write(cwd, requiredItem(selected[0]), "// left mutated\n");
        } else if (command === "merge") {
          const reportPaths = argv.slice(argv.indexOf("--config") + 2, argv.indexOf("--plan"));
          fixture.report.results = reportPaths.flatMap(
            (path) => JSON.parse(readFileSync(path, "utf8")).results,
          );
          const { evidenceArchive: _archive, ...merged } = fixture.report;
          writeFileSync(outputPath, JSON.stringify(merged));
        } else if (command === "verify-run")
          output = state.malformed === "verify-run" ? "{}" : JSON.stringify(fixture.verification);
        else if (command === "trust") output = JSON.stringify(fixture.trust);
      }
      if (command === "run" && state.verbose)
        return actualSpawn(
          process.execPath,
          [
            "-e",
            `const fs = require("node:fs");
             fs.writeSync(1, "o".repeat(2 * 1024 * 1024) + "STDOUT-END");
             fs.writeSync(2, "e".repeat(2 * 1024 * 1024) + "STDERR-END");
             process.exit(${state.verboseExit});`,
          ],
          { ...opts, encoding: "utf8" },
        );
      return complete({ status: 0, stdout: output, stderr: "", pid: 1, signal: null, output: [] });
    });
    let status = 0;
    try {
      await import("./run-swift-mutation.ts");
    } catch (error) {
      status = error instanceof Error && "status" in error ? Number(error.status) : 1;
      stderr.push(String(error));
    }
    return { status, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  }
  return { root, addPackage, commitBase, change, run, calls, state };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("run-swift-mutation public CLI", () => {
  it.each([0, 23])(
    "retains complete verbose streams and exit %s from a real Node child",
    async (exit) => {
      const fixture = createFixture();
      fixture.addPackage(whoop);
      const base = fixture.commitBase();
      fixture.change(`${whoop}/ios/Parser.swift`);
      fixture.state.verboseExit = exit;
      fixture.state.verbose = true;
      const result = await fixture.run(base);
      expect(result.status, result.stderr).toBe(exit);
      const evidence = JSON.parse(
        readFileSync(
          join(
            fixture.root,
            `reports/swift-mutation/files/${whoop}/ios/Parser.swift/workers/0/run.command.json`,
          ),
          "utf8",
        ),
      );
      expect(evidence).toMatchObject({ status: exit, signal: null });
      expect(readFileSync(evidence.stdoutPath, "utf8")).toBe(
        `${"o".repeat(2 * 1024 * 1024)}STDOUT-END`,
      );
      expect(readFileSync(evidence.stderrPath, "utf8")).toBe(
        `${"e".repeat(2 * 1024 * 1024)}STDERR-END`,
      );
      expect(JSON.stringify(evidence).length).toBeLessThan(4096);
      expect(result.stdout).toContain("STDOUT-END");
      expect(result.stderr).toContain("STDERR-END");
      expect(fixture.calls.some((call) => call.args[0] === "verify-run")).toBe(exit === 0);
      expect(fixture.calls.some((call) => call.args[0] === "trust")).toBe(exit === 0);
    },
  );
  it("records verified empty candidates as not applicable during preparation", async () => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    const base = fixture.commitBase();
    fixture.change(`${whoop}/ios/Parser.swift`);
    fixture.state.zero = true;
    const result = await fixture.run(base, ["--prepare"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
    const campaign = JSON.parse(
      readFileSync(join(fixture.root, "reports/swift-mutation/campaign.json"), "utf8"),
    );
    expect(campaign.files[0]).toMatchObject({
      source: `${whoop}/ios/Parser.swift`,
      status: "notApplicable",
      jobs: [],
    });
    expect(
      fixture.calls.some((call) => call.tool === "mutantkit" && call.args[0] === "verify"),
    ).toBe(true);
    expect(fixture.calls.some((call) => call.tool === "mutantkit" && call.args[0] === "run")).toBe(
      false,
    );
  });

  it("increases the official shard count after an oversized partition, executes every bounded shard, and merges all candidates", async () => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    const base = fixture.commitBase();
    fixture.change(`${whoop}/ios/Parser.swift`);
    fixture.state.candidates = 25;
    fixture.state.oversizedFirstPartition = true;
    const prepared = await fixture.run(base, ["--prepare"]);
    expect(prepared.status, prepared.stderr).toBe(0);
    const jobs = JSON.parse(prepared.stdout);
    expect(jobs).toHaveLength(4);
    expect(
      fixture.calls
        .filter((call) => call.tool === "mutantkit" && call.args[0] === "shard")
        .map((call) => Number(call.args[call.args.indexOf("--count") + 1])),
    ).toEqual([3, 4]);
    for (const job of jobs) {
      const result = await fixture.run(base, ["--job", JSON.stringify(job)]);
      expect(result.status, result.stderr).toBe(0);
    }
    const merged = await fixture.run(base, ["--merge"]);
    expect(merged.status, merged.stderr).toBe(0);
    const runCounts = fixture.calls
      .filter((call) => call.tool === "mutantkit" && call.args[0] === "run")
      .map(
        (call) =>
          JSON.parse(readFileSync(requiredItem(call.args[call.args.indexOf("--plan") + 1]), "utf8"))
            .mutations.length,
      );
    expect(runCounts.reduce((sum, value) => sum + value, 0)).toBe(25);
    expect(runCounts.every((count) => count > 0 && count <= 12)).toBe(true);
    expect(
      fixture.calls.some((call) => call.tool === "mutantkit" && call.args[0] === "merge"),
    ).toBe(true);
  });

  it.each([
    { candidates: 3072, sources: ["Parser.swift"], workers: 256 },
    { candidates: 3073, sources: ["Parser.swift"], workers: 257 },
    { candidates: 1537, sources: ["Parser.swift", "Other.swift"], workers: 258 },
  ])(
    "checks the complete $workers-worker matrix against GitHub's limit before emitting it",
    async ({ candidates, sources, workers }) => {
      const fixture = createFixture();
      fixture.addPackage(whoop, "ios", sources);
      const base = fixture.commitBase();
      for (const source of sources) fixture.change(`${whoop}/ios/${source}`);
      fixture.state.candidates = candidates;
      const result = await fixture.run(base, ["--prepare"]);
      if (workers <= 256) {
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toHaveLength(workers);
      } else {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          `Swift mutation campaign requires ${workers} workers, exceeding GitHub Actions' 256-job matrix limit`,
        );
        expect(result.stdout).toBe("");
      }
      const campaign = JSON.parse(
        readFileSync(join(fixture.root, "reports/swift-mutation/campaign.json"), "utf8"),
      );
      expect(campaign.files.flatMap((file: { jobs: number[] }) => file.jobs)).toHaveLength(workers);
      const planned = sources.flatMap(
        (source) =>
          JSON.parse(
            readFileSync(
              join(fixture.root, `reports/swift-mutation/files/${whoop}/ios/${source}/plan.json`),
              "utf8",
            ),
          ).mutations,
      );
      expect(planned).toHaveLength(candidates * sources.length);
    },
  );

  it("rejects a source left changed after the mutation command", async () => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    const base = fixture.commitBase();
    fixture.change(`${whoop}/ios/Parser.swift`);
    fixture.state.changedAfterRun = true;
    const result = await fixture.run(base);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Stale mutation plan hash");
    expect(fixture.calls.some((call) => call.args[0] === "verify-run")).toBe(false);
  });

  it("fails closed when a selected shard has not produced its report", async () => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    const base = fixture.commitBase();
    fixture.change(`${whoop}/ios/Parser.swift`);
    expect((await fixture.run(base, ["--prepare"])).status).toBe(0);
    const result = await fixture.run(base, ["--merge"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("report.json");
  });

  it("rejects duplicate candidates emitted by the official partition boundary", async () => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    const base = fixture.commitBase();
    fixture.change(`${whoop}/ios/Parser.swift`);
    fixture.state.candidates = 13;
    fixture.state.duplicateShard = true;
    const result = await fixture.run(base, ["--prepare"]);
    expect(result.status).not.toBe(0);
    expect(fixture.calls.some((call) => call.args[0] === "run")).toBe(false);
  });

  it.each(["commit", "source", "job"])("rejects stale or unselected worker %s", async (problem) => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    const base = fixture.commitBase();
    fixture.change(`${whoop}/ios/Parser.swift`);
    expect((await fixture.run(base, ["--prepare"])).status).toBe(0);
    if (problem === "commit") fixture.commitBase();
    if (problem === "source")
      write(fixture.root, `${whoop}/ios/Parser.swift`, "// changed again\n");
    const result = await fixture.run(base, [
      "--job",
      JSON.stringify({ file: `${whoop}/ios/Parser.swift`, shard: problem === "job" ? 9 : 0 }),
    ]);
    expect(result.status).not.toBe(0);
    expect(fixture.calls.some((call) => call.args[0] === "run")).toBe(false);
  });

  it("reverifies a wholly zero-candidate campaign without producing a score", async () => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    const base = fixture.commitBase();
    fixture.change(`${whoop}/ios/Parser.swift`);
    fixture.state.zero = true;
    expect((await fixture.run(base, ["--prepare"])).status).toBe(0);
    const result = await fixture.run(base, ["--merge"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("no mutation score");
    expect(fixture.calls.filter((call) => call.args[0] === "verify")).toHaveLength(2);
    expect(fixture.calls.some((call) => call.args[0] === "merge")).toBe(false);
  });

  it("lists changed compiled files without running the mutation tool", async () => {
    const fixture = createFixture();
    fixture.addPackage(whoop, "ios", ["Parser.swift", "nested/Timer space.swift"]);
    fixture.addPackage(healthKit);
    const base = fixture.commitBase();
    for (const path of [
      `${whoop}/ios/Parser.swift`,
      `${whoop}/ios/nested/Timer space.swift`,
      `${healthKit}/ios/Parser.swift`,
      `${whoop}/Tests/ParserTests.swift`,
      `${whoop}/ios/ExpoModule.swift`,
    ])
      fixture.change(path);
    const result = await fixture.run(base, ["--list-files"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      `${healthKit}/ios/Parser.swift`,
      `${whoop}/ios/Parser.swift`,
      `${whoop}/ios/nested/Timer space.swift`,
    ]);
    expect(fixture.calls.map((call) => call.tool)).toEqual(["git", "swift", "swift"]);
  });
  it("scopes the official plan to the requested file and retains full-package tests", async () => {
    const fixture = createFixture();
    fixture.addPackage(whoop, "ios", ["Parser.swift", "nested/Timer space.swift"]);
    const base = fixture.commitBase();
    fixture.change(`${whoop}/ios/Parser.swift`);
    fixture.change(`${whoop}/ios/nested/Timer space.swift`);
    const result = await fixture.run(base, ["--file", `${whoop}/ios/nested/Timer space.swift`]);
    expect(result.status, result.stderr).toBe(0);
    expect(
      fixture.calls.filter((call) => call.tool === "mutantkit").map((call) => call.args[0]),
    ).toEqual([
      "config",
      "plan",
      "verify",
      "shard",
      "verify",
      "run",
      "verify-run",
      "trust",
      "verify",
      "verify-run",
      "trust",
      "merge",
    ]);
    const run = requiredItem(
      fixture.calls.find((call) => call.tool === "mutantkit" && call.args[0] === "run"),
    );
    expect(
      parse(readFileSync(requiredItem(run.args[run.args.indexOf("--config") + 1]), "utf8")),
    ).toEqual({
      project: { kind: "swiftPackageMacOS" },
      reports: ["console", "json"],
      evidence: { archive: true },
      sources: { include: ["ios/nested/Timer space.swift"] },
    });
    expect(run.args).toContain("--no-resume");
    expect(run.args).toContain("--no-history");
    expect(fixture.calls.find((call) => call.tool === "swiftc")?.args).toContain(
      join(fixture.root, whoop, "ios/nested/Timer space.swift"),
    );
  });
  it("routes each package's changed compiled sources to its own full test run", async () => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    fixture.addPackage(healthKit);
    const base = fixture.commitBase();
    fixture.change(`${whoop}/ios/Parser.swift`);
    fixture.change(`${healthKit}/ios/Parser.swift`);
    const result = await fixture.run(base);
    expect(result.status, result.stderr).toBe(0);
    expect(
      fixture.calls
        .filter((call) => call.tool === "mutantkit" && call.args[0] === "run")
        .map((call) => call.cwd),
    ).toEqual([join(fixture.root, healthKit), join(fixture.root, whoop)]);
  });
  it("selects from the merge base when the base branch has diverged", async () => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    fixture.addPackage(healthKit);
    const common = fixture.commitBase();
    fixture.change(`${healthKit}/ios/Parser.swift`);
    const main = fixture.commitBase();
    write(fixture.root, `${healthKit}/ios/Parser.swift`, "// source\n");
    fixture.change(`${whoop}/ios/Parser.swift`);
    git(fixture.root, ["add", "."]);
    const tree = git(fixture.root, ["write-tree"]);
    git(fixture.root, [
      "update-ref",
      "HEAD",
      git(fixture.root, ["commit-tree", tree, "-p", common, "-m", "feature"]),
    ]);
    expect((await fixture.run(main)).status).toBe(0);
    expect(fixture.calls[0]?.args).toContain(`${main}...HEAD`);
    expect(
      fixture.calls
        .filter((call) => call.tool === "mutantkit" && call.args[0] === "run")
        .map((call) => call.cwd),
    ).toEqual([join(fixture.root, whoop)]);
  });
  it.each([
    "ios/ExpoModule.swift",
    "Tests/ParserTests.swift",
    "ios/Missing.swift",
    "ios/Unchanged.swift",
  ])("rejects an unselected file %s", async (path) => {
    const fixture = createFixture();
    fixture.addPackage(whoop, "ios", ["Parser.swift", "Unchanged.swift"]);
    const base = fixture.commitBase();
    fixture.change(`${whoop}/ios/Parser.swift`);
    const result = await fixture.run(base, ["--file", `${whoop}/${path}`]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Requested file is not a changed compiled Swift source");
  });
  it("rejects combined list and file modes", async () => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    const result = await fixture.run(fixture.commitBase(), [
      "--list-files",
      "--file",
      `${whoop}/ios/Parser.swift`,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Usage:");
  });
  it("fails before mutation when the owning package configuration is missing", async () => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    const base = fixture.commitBase();
    fixture.change(`${whoop}/ios/Parser.swift`);
    rmSync(join(fixture.root, whoop, "mutantkit.yml"));
    const result = await fixture.run(base);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Missing MutantKit configuration");
    expect(fixture.calls.some((call) => call.tool === "mutantkit")).toBe(false);
  });
  it("fails for changed native sources without an owning package", async () => {
    const fixture = createFixture();
    write(fixture.root, "Unsupported.swift", "// base\n");
    const base = fixture.commitBase();
    fixture.change("Unsupported.swift");
    const result = await fixture.run(base);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("No owning Package.swift");
  });
  it("rejects malformed Swift through the real compiler boundary before mutation", async () => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    const base = fixture.commitBase();
    write(fixture.root, `${whoop}/ios/Parser.swift`, "struct Unclosed {\n");
    fixture.state.fail = "swiftc";
    fixture.state.exit = 1;
    const result = await fixture.run(base);
    expect(result.status).toBe(1);
    expect(fixture.calls.some((call) => call.tool === "mutantkit")).toBe(false);
  });
  it("requires the actual evidence archive rather than accepting the reference alone", async () => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    const base = fixture.commitBase();
    fixture.change(`${whoop}/ios/Parser.swift`);
    fixture.state.omit = "archive";
    const result = await fixture.run(base);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Missing mutation evidence archive");
  });
  it("returns an explicit empty intersection and ignores deleted files", async () => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    const base = fixture.commitBase();
    fixture.change(`${whoop}/Tests/ParserTests.swift`);
    rmSync(join(fixture.root, whoop, "ios/Parser.swift"));
    expect((await fixture.run(base, ["--list-files"])).stdout).toBe("[]");
    expect(fixture.calls.some((call) => call.tool === "mutantkit")).toBe(false);
  });
  it("supports root-relative watch target inventories", async () => {
    const fixture = createFixture();
    const path = "packages/mobile/targets/DofekWatch";
    fixture.addPackage(path, ".", ["Cursor.swift"]);
    const base = fixture.commitBase();
    fixture.change(`${path}/Cursor.swift`);
    const result = await fixture.run(base);
    expect(result.status, result.stderr).toBe(0);
  });
  it.each(["plan", "report"])("rejects stale %s after output omission", async (omitted) => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    const base = fixture.commitBase();
    fixture.change(`${whoop}/ios/Parser.swift`);
    write(
      fixture.root,
      `reports/swift-mutation/files/${whoop}/ios/Parser.swift/${omitted === "report" ? "workers/0/" : ""}${omitted}.json`,
      "{}",
    );
    fixture.state.omit = omitted;
    const result = await fixture.run(base);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${omitted}.json`);
  });
  it.each(["swift", "inventory", "plan", "report", "verify-run"])(
    "rejects malformed %s",
    async (malformed) => {
      const fixture = createFixture();
      fixture.addPackage(whoop);
      const base = fixture.commitBase();
      fixture.change(`${whoop}/ios/Parser.swift`);
      fixture.state.malformed = malformed;
      expect((await fixture.run(base)).status).not.toBe(0);
    },
  );
  it.each(["stale", "missing", "corrupt"] as const)("rejects %s work", async (problem) => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    const base = fixture.commitBase();
    fixture.change(`${whoop}/ios/Parser.swift`);
    fixture.state[problem] = true;
    expect((await fixture.run(base)).status).not.toBe(0);
  });
  it.each(["swift", "swiftc", "config", "plan", "verify", "run", "verify-run", "trust"])(
    "preserves %s failure status and command evidence",
    async (command) => {
      const fixture = createFixture();
      fixture.addPackage(whoop);
      const base = fixture.commitBase();
      fixture.change(`${whoop}/ios/Parser.swift`);
      fixture.state.fail = command;
      fixture.state.exit = 42;
      const result = await fixture.run(base);
      expect(result.status, result.stderr).toBe(42);
      if (command !== "swift") {
        const evidence = JSON.parse(
          readFileSync(
            join(
              fixture.root,
              `reports/swift-mutation/files/${whoop}/ios/Parser.swift`,
              ["run", "verify-run", "trust"].includes(command) ? "workers/0" : "",
              `${command === "swiftc" ? "compiler" : command}.command.json`,
            ),
            "utf8",
          ),
        );
        expect(evidence).toMatchObject({ status: 42, signal: null });
        expect(readFileSync(evidence.stderrPath, "utf8")).toBe(`${command} rejected fixture`);
        expect(readFileSync(evidence.stdoutPath, "utf8")).toBe("");
      }
    },
  );
});
