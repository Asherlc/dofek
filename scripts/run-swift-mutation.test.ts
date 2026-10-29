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
    missing: false,
    stale: false,
    corrupt: false,
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
    commitBase();
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
        argv: { value: [process.execPath, "run-swift-mutation.ts", "--base", base, ...options] },
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
      if (state.fail === command)
        return {
          status: state.exit,
          pid: 1,
          signal: null,
          output: [],
          stdout: "",
          stderr: `${command} rejected fixture`,
        } satisfies SpawnSyncReturns<string>;
      let output = tool === "swift" ? JSON.stringify(inventories.get(cwd)) : "";
      if (tool === "swift" && state.malformed === "swift") output = "invalid-json";
      if (tool === "swift" && state.malformed === "inventory") output = "{}";
      if (tool === "mutantkit") {
        const config = parse(
          readFileSync(requiredItem(argv[argv.indexOf("--config") + 1]), "utf8"),
        );
        const selected: string[] = config.sources.include;
        const fixture = mutationFixture(
          cwd,
          Object.fromEntries(
            selected.map((file) => [file, hash(readFileSync(join(cwd, file), "utf8"))]),
          ),
        );
        const outputPath = requiredItem(argv[argv.indexOf("--output") + 1]);
        if (command === "plan") {
          if (state.zero) fixture.plan.mutations = [];
          if (state.stale) fixture.plan.sourceFileHashes[requiredItem(selected[0])] = hash("stale");
          if (state.omit !== "plan")
            writeFileSync(
              outputPath,
              state.malformed === "plan" ? "invalid-json" : JSON.stringify(fixture.plan),
            );
        } else if (command === "verify")
          output = JSON.stringify({
            schemaVersion: 1,
            planID: fixture.plan.planID,
            mutationCount: selected.length,
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
        } else if (command === "verify-run")
          output = state.malformed === "verify-run" ? "{}" : JSON.stringify(fixture.verification);
        else if (command === "trust") output = JSON.stringify(fixture.trust);
      }
      return { status: 0, stdout: output, stderr: "", pid: 1, signal: null, output: [] };
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
    ).toEqual(["config", "plan", "verify", "run", "verify-run", "trust"]);
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
    write(fixture.root, `reports/swift-mutation/whoop-ble/${omitted}.json`, "{}");
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
  it.each(["zero", "stale", "missing", "corrupt"] as const)("rejects %s work", async (problem) => {
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
      if (command !== "swift" && command !== "swiftc")
        expect(
          JSON.parse(
            readFileSync(
              join(fixture.root, "reports/swift-mutation/whoop-ble", `${command}.command.json`),
              "utf8",
            ),
          ),
        ).toMatchObject({ status: 42, stderr: `${command} rejected fixture` });
    },
  );
});
