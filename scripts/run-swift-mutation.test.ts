import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = resolve("scripts/run-swift-mutation.ts");
const tsxPath = createRequire(import.meta.url).resolve("tsx/cli");
const fixtures: string[] = [];
const whoop = "packages/mobile/modules/whoop-ble";
const healthKit = "packages/mobile/modules/health-kit";
const positiveReport = {
  globalMutationScore: 50,
  totalAppliedMutationOperators: 2,
  numberOfKilledMutants: 1,
  fileReports: [{ fileName: "Parser.swift", mutationScore: 50, appliedOperators: [{}] }],
};

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
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function createFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "swift-mutation-test-")));
  fixtures.push(root);
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "Mutation Fixture"]);
  git(root, ["config", "user.email", "mutation@example.test"]);
  write(root, "packages/mobile/muter.conf.yml", "executable: /usr/bin/swift\narguments: [test]\n");
  const log = join(root, "invocations.jsonl");
  mkdirSync(join(root, "bin"));
  symlinkSync(process.execPath, join(root, "bin/node"));
  symlinkSync("/usr/bin/git", join(root, "bin/git"));
  for (const tool of ["swift", "muter"]) {
    const source = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({tool: ${JSON.stringify(tool)}, cwd: process.cwd(), args: process.argv.slice(2)}) + '\\n');
const statePath = path.join(process.cwd(), '${tool}-fixture.json');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
if (state.exit) { console.error('${tool} fixture failure'); process.exit(state.exit); }
if (${JSON.stringify(tool)} === 'swift') {
  process.stdout.write(state.raw ?? JSON.stringify(state.description));
} else {
  const reportPath = process.argv[process.argv.indexOf('--output') + 1];
  if (!state.omitReport) fs.writeFileSync(reportPath, state.raw ?? JSON.stringify(state.report ?? ${JSON.stringify(positiveReport)}));
}
`;
    write(root, `bin/${tool}`, source);
    chmodSync(join(root, `bin/${tool}`), 0o755);
  }
  function addPackage(path: string, targetPath = "ios", sources = ["Parser.swift"]) {
    write(root, `${path}/Package.swift`, "// fixture package\n");
    for (const source of sources) write(root, `${path}/${targetPath}/${source}`, "// source\n");
    write(root, `${path}/ios/ExpoModule.swift`, "// excluded Expo bridge\n");
    write(root, `${path}/Tests/ParserTests.swift`, "// tests\n");
    write(
      root,
      `${path}/swift-fixture.json`,
      JSON.stringify({
        description: {
          targets: [
            { type: "library", module_type: "SwiftTarget", path: targetPath, sources },
            {
              type: "test",
              module_type: "SwiftTarget",
              path: "Tests",
              sources: ["ParserTests.swift"],
            },
          ],
        },
      }),
    );
    symlinkSync("../../muter.conf.yml", join(root, path, "muter.conf.yml"));
  }
  function commitBase() {
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "fixture"]);
    return git(root, ["rev-parse", "HEAD"]);
  }
  function change(path: string) {
    write(root, path, "// changed\n");
  }
  function run(base: string) {
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "--allow-empty", "-m", "feature changes"]);
    return spawnSync(process.execPath, [tsxPath, scriptPath, "--base", base], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: join(root, "bin") },
    });
  }
  function invocations(): Invocation[] {
    return existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  }
  return { root, addPackage, commitBase, change, run, invocations };
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("run-swift-mutation public CLI", () => {
  it("selects committed PR changes from the merge base when main has diverged", () => {
    const fixture = createFixture();
    const backgroundRefresh = "packages/mobile/modules/background-refresh";
    fixture.addPackage(whoop);
    fixture.addPackage(backgroundRefresh);
    const commonBase = fixture.commitBase();
    fixture.change(`${backgroundRefresh}/ios/Parser.swift`);
    const mainTip = fixture.commitBase();

    write(fixture.root, `${backgroundRefresh}/ios/Parser.swift`, "// source\n");
    fixture.change(`${whoop}/ios/Parser.swift`);
    git(fixture.root, ["add", "."]);
    const featureTree = git(fixture.root, ["write-tree"]);
    const featureTip = git(fixture.root, [
      "commit-tree",
      featureTree,
      "-p",
      commonBase,
      "-m",
      "feature",
    ]);
    git(fixture.root, ["update-ref", "HEAD", featureTip]);

    const result = fixture.run(mainTip);

    expect(result.status, result.stderr).toBe(0);
    expect(
      fixture
        .invocations()
        .filter((invocation) => invocation.tool === "muter")
        .map((invocation) => invocation.cwd),
    ).toEqual([join(fixture.root, whoop)]);
  });

  it("routes changed compiled Swift sources to each owning package with relative paths", () => {
    const fixture = createFixture();
    fixture.addPackage(whoop, "ios", ["Parser.swift", "nested/Connection+Timer space.swift"]);
    fixture.addPackage(healthKit);
    const base = fixture.commitBase();
    for (const path of [
      `${whoop}/ios/Parser.swift`,
      `${whoop}/ios/nested/Connection+Timer space.swift`,
      `${whoop}/ios/ExpoModule.swift`,
      `${whoop}/Tests/ParserTests.swift`,
      `${whoop}/Package.swift`,
      `${healthKit}/ios/Parser.swift`,
    ])
      fixture.change(path);

    const result = fixture.run(base);

    expect(result.status, result.stderr).toBe(0);
    const runs = fixture.invocations().filter((invocation) => invocation.tool === "muter");
    expect(runs).toHaveLength(2);
    for (const [path, files] of [
      [whoop, ["ios/Parser.swift", "ios/nested/Connection+Timer space.swift"]],
      [healthKit, ["ios/Parser.swift"]],
    ] as const) {
      const run = runs.find((invocation) => invocation.cwd === join(fixture.root, path));
      expect(run?.args).toEqual([
        "run",
        "--files-to-mutate",
        files.join(","),
        "--format",
        "json",
        "--output",
        join(fixture.root, "reports/swift-mutation", `${path.split("/").at(-1)}.json`),
      ]);
    }
    expect(
      fixture
        .invocations()
        .filter((invocation) => invocation.tool === "swift")
        .every((invocation) => invocation.args.join(" ") === "package describe --type json"),
    ).toBe(true);
    expect(result.stdout).toContain("2 mutants, 1 killed, score 50%");
  });

  it("uses root-relative target inventories such as the watch package", () => {
    const fixture = createFixture();
    const watch = "packages/mobile/targets/DofekWatch";
    fixture.addPackage(watch, ".", ["Cursor.swift"]);
    const base = fixture.commitBase();
    fixture.change(`${watch}/Cursor.swift`);
    const result = fixture.run(base);
    expect(result.status, result.stderr).toBe(0);
    expect(fixture.invocations().find((invocation) => invocation.tool === "muter")?.args).toContain(
      "Cursor.swift",
    );
  });

  it("skips an authoritative empty source intersection including manifest, test and bridge changes", () => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    const base = fixture.commitBase();
    for (const path of ["Package.swift", "Tests/ParserTests.swift", "ios/ExpoModule.swift"]) {
      fixture.change(`${whoop}/${path}`);
    }
    const result = fixture.run(base);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("No changed compiled Swift sources");
    expect(fixture.invocations().map((invocation) => invocation.tool)).toEqual(["swift"]);
  });

  it("ignores deleted Swift files", () => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    const base = fixture.commitBase();
    rmSync(join(fixture.root, whoop, "ios/Parser.swift"));
    const result = fixture.run(base);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("No changed compiled Swift sources");
    expect(fixture.invocations()).toEqual([]);
  });

  it.each([1, 42, 255])("preserves Muter failure status %i", (exit) => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    const base = fixture.commitBase();
    fixture.change(`${whoop}/ios/Parser.swift`);
    write(fixture.root, `${whoop}/muter-fixture.json`, JSON.stringify({ exit }));
    const result = fixture.run(base);
    expect(result.status).toBe(exit);
    expect(result.stderr).toContain(`muter failed for ${whoop}`);
  });

  it("fails on SwiftPM discovery errors instead of treating them as no work", () => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    const base = fixture.commitBase();
    fixture.change(`${whoop}/ios/Parser.swift`);
    write(fixture.root, `${whoop}/swift-fixture.json`, JSON.stringify({ exit: 7 }));
    const result = fixture.run(base);
    expect(result.status).toBe(7);
    expect(result.stderr).toContain(`swift failed for ${whoop}`);
  });

  it.each([
    ["malformed JSON", { raw: "invalid-json" }],
    ["missing inventory", { description: {} }],
  ])("fails on %s from SwiftPM", (_label, state) => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    const base = fixture.commitBase();
    fixture.change(`${whoop}/ios/Parser.swift`);
    write(fixture.root, `${whoop}/swift-fixture.json`, JSON.stringify(state));
    const result = fixture.run(base);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(`SwiftPM description for ${whoop}`);
  });

  it("fails explicitly for changed native Swift without an owning package", () => {
    const fixture = createFixture();
    write(fixture.root, "packages/mobile/native/Unsupported.swift", "// source\n");
    const base = fixture.commitBase();
    fixture.change("packages/mobile/native/Unsupported.swift");
    const result = fixture.run(base);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "No owning Package.swift for packages/mobile/native/Unsupported.swift",
    );
  });

  it("fails before mutation when package configuration is missing", () => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    const base = fixture.commitBase();
    fixture.change(`${whoop}/ios/Parser.swift`);
    rmSync(join(fixture.root, whoop, "muter.conf.yml"));
    const result = fixture.run(base);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${whoop}/muter.conf.yml`);
    expect(fixture.invocations().filter((invocation) => invocation.tool === "muter")).toEqual([]);
  });

  it("fails explicitly when Muter is unavailable", () => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    const base = fixture.commitBase();
    fixture.change(`${whoop}/ios/Parser.swift`);
    // An executable with a missing interpreter reproduces spawn ENOENT without using installed Muter.
    write(fixture.root, "bin/muter", "#!/nonexistent/muter-interpreter\n");
    const result = fixture.run(base);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Could not start muter for ${whoop}`);
  });

  it.each([
    ["missing", { omitReport: true }],
    ["malformed", { raw: "invalid-json" }],
    ["zero work", { report: { ...positiveReport, totalAppliedMutationOperators: 0 } }],
    ["missing fields", { report: {} }],
    ["empty files", { report: { ...positiveReport, fileReports: [] } }],
  ])("fails when a successful selected-source run returns a %s report", (_label, state) => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    const base = fixture.commitBase();
    fixture.change(`${whoop}/ios/Parser.swift`);
    write(fixture.root, `${whoop}/muter-fixture.json`, JSON.stringify(state));
    const result = fixture.run(base);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("whoop-ble.json");
  });

  it("does not accept a stale report when the selected run emits no report", () => {
    const fixture = createFixture();
    fixture.addPackage(whoop);
    const base = fixture.commitBase();
    fixture.change(`${whoop}/ios/Parser.swift`);
    write(fixture.root, "reports/swift-mutation/whoop-ble.json", JSON.stringify(positiveReport));
    write(fixture.root, `${whoop}/muter-fixture.json`, JSON.stringify({ omitReport: true }));
    const result = fixture.run(base);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("whoop-ble.json");
  });
});
