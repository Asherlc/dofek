import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import {
  validateMutationPlan,
  validateMutationReport,
  validateMutationTrust,
  validatePlanVerification,
  validateRunVerification,
} from "./swift-mutation-report.ts";
import { getMutantKitExecutable } from "./swift-mutation-tool.ts";

const args = process.argv.slice(2);
const listFiles = args.length === 3 && args[2] === "--list-files";
const requestedFile = args.length === 4 && args[2] === "--file" ? args[3] : undefined;
if (args[0] !== "--base" || !args[1] || !(args.length === 2 || listFiles || requestedFile)) {
  throw new Error(
    "Usage: pnpm tsx scripts/run-swift-mutation.ts --base <git-ref> [--list-files | --file <repo-relative-path>]",
  );
}

const root = process.cwd();

function run(command: string, commandArgs: string[], cwd: string, evidencePath?: string): string {
  const context = relative(root, cwd) || ".";
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (evidencePath)
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          command,
          args: commandArgs,
          cwd,
          status: result.status,
          signal: result.signal,
          error: result.error?.message,
          stdout: result.stdout,
          stderr: result.stderr,
        },
        null,
        2,
      ),
    );
  if (result.stderr) console.error(result.stderr);
  if (result.error) {
    throw new Error(`Could not start ${command} for ${context}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    console.error(`${command} failed for ${context}: ${result.signal ?? `exit ${result.status}`}`);
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? "";
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
  console.error(`Reading ${context}`);
  const description = z
    .object({
      targets: z.array(
        z.object({
          type: z.string(),
          module_type: z.string(),
          path: z.string().optional(),
          sources: z.array(z.string()).optional(),
        }),
      ),
    })
    .parse(JSON.parse(run("swift", ["package", "describe", "--type", "json"], directory)));
  const sources = new Set<string>();
  for (const target of description.targets) {
    if (target.type === "test" || target.module_type !== "SwiftTarget") continue;
    if (typeof target.path !== "string" || !Array.isArray(target.sources)) {
      throw new Error(`Invalid ${context}: Swift target path and sources are required`);
    }
    for (const source of target.sources) {
      sources.add(relative(directory, resolve(directory, target.path, source)));
    }
  }
  return sources;
}

function readJson(path: string): unknown {
  if (!existsSync(path)) throw new Error(`MutantKit did not produce ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function mutatePackage(executable: string, directory: string, selected: string[]): void {
  const output = join(root, "reports/swift-mutation", basename(directory));
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const config = z
    .object({
      project: z.object({ kind: z.literal("swiftPackageMacOS") }).passthrough(),
      reports: z
        .array(z.enum(["console", "json"]))
        .refine((kinds) => kinds.includes("console") && kinds.includes("json")),
      evidence: z.object({ archive: z.literal(true) }).passthrough(),
    })
    .passthrough()
    .parse(parse(readFileSync(join(directory, "mutantkit.yml"), "utf8")));
  const configPath = join(output, "mutantkit.yml");
  writeFileSync(configPath, stringify({ ...config, sources: { include: selected } }));
  const sources = Object.fromEntries(
    selected.map((file) => [
      file,
      `sha256:${createHash("sha256")
        .update(readFileSync(join(directory, file)))
        .digest("hex")}`,
    ]),
  );
  writeFileSync(join(output, "inputs.json"), JSON.stringify(sources, null, 2));
  run(
    "swiftc",
    ["-frontend", "-parse", ...selected.map((file) => join(directory, file))],
    directory,
    join(output, "compiler.command.json"),
  );
  const common = ["--project-root", directory, "--config", configPath];
  function command(name: string, commandArgs: string[]): string {
    return run(
      executable,
      [name, ...common, ...commandArgs],
      directory,
      join(output, `${name}.command.json`),
    );
  }
  function jsonCommand(name: string, commandArgs: string[]): unknown {
    const path = join(output, `${name}.json`);
    writeFileSync(path, command(name, [...commandArgs, "--json"]));
    return readJson(path);
  }
  const planPath = join(output, "plan.json");
  const reportPath = join(output, "report.json");
  command("config", []);
  command("plan", ["--output", planPath]);
  const plan = validateMutationPlan(readJson(planPath), { projectRoot: directory, sources });
  validatePlanVerification(jsonCommand("verify", ["--plan", planPath]), plan);
  console.log(`Mutating ${relative(root, directory)}: ${selected.join(", ")}`);
  console.log(
    command("run", ["--plan", planPath, "--output", reportPath, "--no-resume", "--no-history"]),
  );
  const report = validateMutationReport(readJson(reportPath), plan);
  const archive = join(directory, ".mutantkit/evidence", report.evidenceArchive.runID);
  if (!existsSync(join(archive, "manifest.json")))
    throw new Error(`Missing mutation evidence archive ${archive}`);
  const copiedArchive = join(output, "evidence");
  cpSync(archive, copiedArchive, { recursive: true });
  const verificationArgs = ["--plan", planPath, "--evidence", copiedArchive];
  validateRunVerification(jsonCommand("verify-run", [reportPath, ...verificationArgs]), plan);
  validateMutationTrust(jsonCommand("trust", ["--report", reportPath, ...verificationArgs]), plan);
  console.log(
    `${basename(directory)}: ${report.results.length} mutants; ${JSON.stringify(report.score)}. All required source/archive checks passed; optional assertion confirmation may remain unverified.`,
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

const selectedByPackage = new Map<string, string[]>();
for (const [directory, paths] of packages) {
  const inventory = compiledSources(directory);
  const selected = paths.filter((path) => inventory.has(path));
  if (selected.length === 0) continue;
  const configPath = join(directory, "mutantkit.yml");
  if (!existsSync(configPath)) throw new Error(`Missing MutantKit configuration ${configPath}`);
  selectedByPackage.set(directory, selected);
}
const selectedFiles = [...selectedByPackage].flatMap(([directory, paths]) =>
  paths.map((path) => relative(root, resolve(directory, path))),
);
if (requestedFile && !selectedFiles.includes(requestedFile)) {
  throw new Error(`Requested file is not a changed compiled Swift source: ${requestedFile}`);
}

if (listFiles) {
  console.log(JSON.stringify(selectedFiles));
} else if (selectedFiles.length === 0) {
  console.log("No changed compiled Swift sources; skipping mutation testing.");
} else {
  const executable = getMutantKitExecutable((command, commandArgs) =>
    run(command, commandArgs, root),
  );
  for (const [directory, paths] of selectedByPackage) {
    const selected = requestedFile
      ? paths.filter((path) => relative(root, resolve(directory, path)) === requestedFile)
      : paths;
    if (selected.length === 0) continue;
    mutatePackage(executable, directory, selected);
  }
}
