import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--base" || !args[1]) {
  throw new Error("Usage: pnpm tsx scripts/run-swift-mutation.ts --base <git-ref>");
}

const root = process.cwd();

function run(command: string, commandArgs: string[], cwd: string, inheritOutput = false): string {
  const context = relative(root, cwd) || ".";
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    stdio: inheritOutput ? "inherit" : ["ignore", "pipe", "inherit"],
  });
  if (result.error) {
    throw new Error(`Could not start ${command} for ${context}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    console.error(`${command} failed for ${context}: ${result.signal ?? `exit ${result.status}`}`);
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? "";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function owningPackage(path: string): string {
  let directory = dirname(resolve(root, path));
  while (directory !== root) {
    if (existsSync(join(directory, "Package.swift"))) return directory;
    directory = dirname(directory);
  }
  if (existsSync(join(root, "Package.swift"))) return root;
  throw new Error(`No owning Package.swift for ${path}`);
}

function compiledSources(directory: string): Set<string> {
  const context = `SwiftPM description for ${relative(root, directory)}`;
  console.log(`Reading ${context}`);
  const description: unknown = JSON.parse(
    run("swift", ["package", "describe", "--type", "json"], directory),
  );
  if (!record(description) || !Array.isArray(description.targets)) {
    throw new Error(`Invalid ${context}: targets array is required`);
  }
  const sources = new Set<string>();
  for (const target of description.targets) {
    if (
      !record(target) ||
      typeof target.type !== "string" ||
      typeof target.module_type !== "string"
    ) {
      throw new Error(`Invalid ${context}: target type and module_type are required`);
    }
    if (target.type === "test" || target.module_type !== "SwiftTarget") continue;
    if (typeof target.path !== "string" || !Array.isArray(target.sources)) {
      throw new Error(`Invalid ${context}: Swift target path and sources are required`);
    }
    for (const source of target.sources) {
      if (typeof source !== "string") throw new Error(`Invalid ${context}: source must be a path`);
      sources.add(relative(directory, resolve(directory, target.path, source)));
    }
  }
  return sources;
}

function verifyReport(reportPath: string): void {
  if (!existsSync(reportPath)) throw new Error(`Muter did not produce report ${reportPath}`);
  console.log(`Reading Muter report ${reportPath}`);
  const report: unknown = JSON.parse(readFileSync(reportPath, "utf8"));
  if (
    !record(report) ||
    typeof report.globalMutationScore !== "number" ||
    !Number.isFinite(report.globalMutationScore) ||
    typeof report.totalAppliedMutationOperators !== "number" ||
    !Number.isInteger(report.totalAppliedMutationOperators) ||
    report.totalAppliedMutationOperators <= 0 ||
    typeof report.numberOfKilledMutants !== "number" ||
    !Number.isInteger(report.numberOfKilledMutants) ||
    report.numberOfKilledMutants < 0 ||
    report.numberOfKilledMutants > report.totalAppliedMutationOperators ||
    !Array.isArray(report.fileReports) ||
    report.fileReports.length === 0 ||
    !report.fileReports.every(
      (file: unknown) =>
        record(file) &&
        typeof file.fileName === "string" &&
        typeof file.mutationScore === "number" &&
        Number.isFinite(file.mutationScore) &&
        Array.isArray(file.appliedOperators),
    )
  ) {
    throw new Error(`Invalid or zero-work Muter report ${reportPath}`);
  }
  console.log(
    `${basename(reportPath, ".json")}: ${report.totalAppliedMutationOperators} mutants, ` +
      `${report.numberOfKilledMutants} killed, score ${report.globalMutationScore}%`,
  );
}

const changedPaths = run(
  "git",
  ["diff", "--name-only", "-z", "--diff-filter=ACMRT", `${args[1]}...HEAD`, "--"],
  root,
)
  .split("\0")
  .filter((path) => path.endsWith(".swift"));
const packages = new Map<string, string[]>();
for (const path of changedPaths) {
  const directory = owningPackage(path);
  const paths = packages.get(directory) ?? [];
  paths.push(relative(directory, resolve(root, path)));
  packages.set(directory, paths);
}

let selectedPackages = 0;
for (const [directory, paths] of packages) {
  const inventory = compiledSources(directory);
  const selected = paths.filter((path) => inventory.has(path));
  if (selected.length === 0) continue;
  const configPath = join(directory, "muter.conf.yml");
  if (!existsSync(configPath)) throw new Error(`Missing Muter configuration ${configPath}`);
  const reportsDirectory = join(root, "reports/swift-mutation");
  mkdirSync(reportsDirectory, { recursive: true });
  const reportPath = join(reportsDirectory, `${basename(directory)}.json`);
  rmSync(reportPath, { force: true });
  console.log(`Mutating ${relative(root, directory)}: ${selected.join(", ")}`);
  run(
    "muter",
    ["run", "--files-to-mutate", selected.join(","), "--format", "json", "--output", reportPath],
    directory,
    true,
  );
  verifyReport(reportPath);
  selectedPackages += 1;
}
if (selectedPackages === 0)
  console.log("No changed compiled Swift sources; skipping mutation testing.");
