import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = resolve("scripts/check-health-kit-coverage.ts");
const tsxPath = resolve("node_modules/.bin/tsx");
const fixtures: string[] = [];

interface Counts {
  count: number;
  covered: number;
}

function runCoverage(
  options: {
    lines?: Counts[];
    functions?: Counts[];
    missingSource?: boolean;
    swiftExitCode?: number;
  } = {},
) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "healthkit-coverage-")));
  fixtures.push(workspace);
  const packageDirectory = join(workspace, "packages/mobile/modules/health-kit");
  const sourceDirectory = join(packageDirectory, "ios");
  const reportDirectory = join(packageDirectory, ".build/out/Products/Debug/codecov");
  const binDirectory = join(workspace, "bin");
  const reportPath = join(reportDirectory, "HealthKitLib.json");
  const callsPath = join(workspace, "calls.jsonl");
  const outputPath = join(workspace, "github-output");
  for (const directory of [sourceDirectory, reportDirectory, binDirectory]) {
    mkdirSync(directory, { recursive: true });
  }
  const files = ["HealthKitQueries.swift", "HealthKitTypes.swift"].map((name, index) => {
    const filename = join(sourceDirectory, name);
    writeFileSync(filename, "// fixture\n");
    return {
      filename,
      summary: {
        lines: options.lines?.[index] ?? {
          count: index === 0 ? 1 : 9,
          covered: index === 0 ? 0 : 9,
        },
        functions: options.functions?.[index] ?? { count: 10, covered: 9 },
      },
    };
  });
  writeFileSync(
    reportPath,
    JSON.stringify({
      data: [
        {
          files: [
            ...(options.missingSource ? files.slice(1) : files),
            {
              filename: join(packageDirectory, "Tests/HealthKitTypesTests.swift"),
              summary: {
                lines: { count: 10000, covered: 10000 },
                functions: { count: 10000, covered: 10000 },
              },
            },
          ],
        },
      ],
    }),
  );
  writeFileSync(
    join(binDirectory, "swift"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
if (args.includes("--show-codecov-path")) console.log(${JSON.stringify(reportPath)});
else process.exit(${options.swiftExitCode ?? 0});
`,
    { mode: 0o755 },
  );

  const result = spawnSync(tsxPath, [scriptPath], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDirectory}:${process.env.PATH}`, GITHUB_OUTPUT: outputPath },
  });
  return { ...result, callsPath, outputPath, reportDirectory };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe("HealthKit coverage runner", () => {
  it("uses Swift's exported report path and accepts weighted coverage exactly at 90 percent", () => {
    const result = runCoverage();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Line coverage: 90.00%");
    expect(result.stdout).toContain("Function coverage: 90.00%");
    expect(
      readFileSync(result.callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      ["test", "--enable-code-coverage"],
      ["test", "--show-codecov-path"],
    ]);
    expect(readFileSync(result.outputPath, "utf8")).toBe(
      `coverage-directory=${result.reportDirectory}\n`,
    );
  });

  it("rejects line coverage below 90 percent without rounding it up", () => {
    const result = runCoverage({
      lines: [
        { count: 10000, covered: 8999 },
        { count: 10000, covered: 9000 },
      ],
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Line coverage is below 90%");
  });

  it("enforces the function threshold independently", () => {
    const result = runCoverage({
      functions: [
        { count: 10, covered: 8 },
        { count: 10, covered: 9 },
      ],
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Function coverage is below 90%");
  });

  it("fails when a required production source is missing from the report", () => {
    const result = runCoverage({ missingSource: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Coverage report is missing ios/HealthKitQueries.swift");
  });

  it("preserves Swift test failures before checking coverage", () => {
    const result = runCoverage({ swiftExitCode: 23 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("swift test --enable-code-coverage");
    expect(readFileSync(result.callsPath, "utf8").trim()).toBe(
      JSON.stringify(["test", "--enable-code-coverage"]),
    );
  });
});
