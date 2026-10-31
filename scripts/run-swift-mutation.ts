import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parse, stringify } from "yaml";
import { z } from "zod";
import {
  type MutationPlan,
  NATIVE_MUTATIONS_PER_JOB,
  validateMergedMutationReport,
  validateMutationPartition,
  validateMutationPlan,
  validateMutationShardReport,
  validateMutationTrust,
  validatePlanVerification,
  validateRunVerification,
} from "./swift-mutation-report.ts";
import { getMutantKitExecutable } from "./swift-mutation-tool.ts";

const args = process.argv.slice(2);
const listFiles = args.length === 3 && args[2] === "--list-files";
const prepareOnly = args.length === 3 && args[2] === "--prepare";
const requestedFile = args.length === 4 && args[2] === "--file" ? args[3] : undefined;
const workerInput = args.length === 2 && args[0] === "--job" ? args[1] : undefined;
const mergeOnly = args.length === 1 && args[0] === "--merge";
const base =
  args[0] === "--base" &&
  args[1] &&
  (args.length === 2 || listFiles || prepareOnly || requestedFile)
    ? args[1]
    : undefined;
if (!base && !workerInput && !mergeOnly)
  throw new Error(
    "Usage: pnpm tsx scripts/run-swift-mutation.ts --base <git-ref> [--list-files | --prepare | --file <path>], --job <JSON>, or --merge",
  );

const root = process.cwd();

function replay(path: string, print: (chunk: string) => void): void {
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(64 * 1024);
  const decoder = new StringDecoder("utf8");
  try {
    for (let count = readSync(fd, buffer); count > 0; count = readSync(fd, buffer))
      print(decoder.write(buffer.subarray(0, count)));
    const tail = decoder.end();
    if (tail) print(tail);
  } finally {
    closeSync(fd);
  }
}

function run(
  command: string,
  commandArgs: string[],
  cwd: string,
  evidencePath?: string,
  captureStdout = true,
): string {
  const context = relative(root, cwd) || ".";
  const stdoutPath = evidencePath?.replace(/\.json$/, ".stdout.log");
  const stderrPath = evidencePath?.replace(/\.json$/, ".stderr.log");
  const stdoutFd = stdoutPath ? openSync(stdoutPath, "w") : undefined;
  let stderrFd: number | undefined;
  let result: SpawnSyncReturns<string>;
  try {
    stderrFd = stderrPath ? openSync(stderrPath, "w") : undefined;
    result = spawnSync(command, commandArgs, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", stdoutFd ?? "pipe", stderrFd ?? "pipe"],
    });
  } finally {
    if (stdoutFd !== undefined) closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
  }
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
          stdoutPath,
          stderrPath,
        },
        null,
        2,
      ),
    );
  if (stderrPath) replay(stderrPath, (chunk) => console.error(chunk));
  else if (result.stderr) console.error(result.stderr);
  if (stdoutPath && !captureStdout) replay(stdoutPath, (chunk) => console.log(chunk));
  if (result.error) {
    throw new Error(`Could not start ${command} for ${context}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    console.error(`${command} failed for ${context}: ${result.signal ?? `exit ${result.status}`}`);
    process.exit(result.status ?? 1);
  }
  return captureStdout
    ? stdoutPath
      ? readFileSync(stdoutPath, "utf8")
      : (result.stdout ?? "")
    : "";
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

const relativeSource = z
  .string()
  .min(1)
  .refine(
    (path) => !isAbsolute(path) && !path.split(/[\\/]/).includes("..") && path.endsWith(".swift"),
    "Invalid repository-relative Swift source",
  );
const jobSchema = z
  .object({ file: relativeSource, shard: z.number().int().nonnegative() })
  .strict();
const fileSchema = z
  .object({
    source: relativeSource,
    status: z.enum(["planned", "notApplicable"]),
    shardCount: z.number().int().nonnegative(),
    jobs: z.array(z.number().int().nonnegative()),
  })
  .strict();
const campaignSchema = z
  .object({
    schemaVersion: z.literal(1),
    head: z.string().regex(/^[a-f0-9]{40,64}$/),
    files: z.array(fileSchema),
  })
  .strict();
type FileCampaign = z.infer<typeof fileSchema>;
type Campaign = z.infer<typeof campaignSchema>;
const reportRoot = join(root, "reports/swift-mutation");
const campaignPath = join(reportRoot, "campaign.json");
const inventories = new Map<string, Set<string>>();

function sourceContext(source: string) {
  relativeSource.parse(source);
  const directory = owningPackage(source);
  let inventory = inventories.get(directory);
  if (!inventory) {
    inventory = compiledSources(directory);
    inventories.set(directory, inventory);
  }
  const selected = relative(directory, resolve(root, source));
  if (!inventory.has(selected))
    throw new Error(`Source is not compiled by its owning package: ${source}`);
  const output = join(reportRoot, "files", source);
  const configPath = join(output, "mutantkit.yml");
  const sources = {
    [selected]: `sha256:${createHash("sha256")
      .update(readFileSync(join(root, source)))
      .digest("hex")}`,
  };
  return { directory, selected, output, configPath, sources };
}
type SourceContext = ReturnType<typeof sourceContext>;

function commands(executable: string, context: SourceContext, output: string) {
  mkdirSync(output, { recursive: true });
  function command(name: string, commandArgs: string[], captureStdout = true): string {
    return run(
      executable,
      name === "shard"
        ? [name, ...commandArgs]
        : [
            name,
            "--project-root",
            context.directory,
            "--config",
            context.configPath,
            ...commandArgs,
          ],
      context.directory,
      join(output, `${name}.command.json`),
      captureStdout,
    );
  }
  function jsonCommand(name: string, commandArgs: string[]): unknown {
    const path = join(output, `${name}.json`);
    writeFileSync(path, command(name, [...commandArgs, "--json"]));
    return readJson(path);
  }
  return { command, jsonCommand };
}
function readPlan(path: string, context: SourceContext): MutationPlan {
  return validateMutationPlan(readJson(path), {
    projectRoot: context.directory,
    sources: context.sources,
  });
}
function parentPath(context: SourceContext): string {
  return join(context.output, "plan.json");
}
function shardPath(context: SourceContext, index: number): string {
  return join(context.output, "plans", `plan.${index}.json`);
}
function workerOutput(context: SourceContext, index: number): string {
  return join(context.output, "workers", String(index));
}

function prepareSource(executable: string, source: string): FileCampaign {
  const context = sourceContext(source);
  mkdirSync(context.output, { recursive: true });
  if (!existsSync(join(context.directory, "mutantkit.yml")))
    throw new Error(`Missing MutantKit configuration for ${source}`);
  const config = z
    .object({
      project: z.object({ kind: z.literal("swiftPackageMacOS") }).passthrough(),
      reports: z
        .array(z.enum(["console", "json"]))
        .refine((kinds) => kinds.includes("console") && kinds.includes("json")),
      evidence: z.object({ archive: z.literal(true) }).passthrough(),
    })
    .passthrough()
    .parse(parse(readFileSync(join(context.directory, "mutantkit.yml"), "utf8")));
  writeFileSync(
    context.configPath,
    stringify({ ...config, sources: { include: [context.selected] } }),
  );
  writeFileSync(join(context.output, "inputs.json"), JSON.stringify(context.sources, null, 2));
  run(
    "swiftc",
    ["-frontend", "-parse", join(root, source)],
    context.directory,
    join(context.output, "compiler.command.json"),
    false,
  );
  const io = commands(executable, context, context.output);
  io.command("config", []);
  io.command("plan", ["--output", parentPath(context)]);
  const plan = readPlan(parentPath(context), context);
  validatePlanVerification(io.jsonCommand("verify", ["--plan", parentPath(context)]), plan);
  if (plan.mutations.length === 0) {
    console.error(`${source}: not applicable — verified plan contains zero candidates.`);
    return { source, status: "notApplicable", shardCount: 0, jobs: [] };
  }
  let shardCount = Math.ceil(plan.mutations.length / NATIVE_MUTATIONS_PER_JOB);
  let shards: MutationPlan[];
  while (true) {
    const output = join(context.output, "plans");
    rmSync(output, { recursive: true, force: true });
    io.command("shard", [
      parentPath(context),
      "--count",
      String(shardCount),
      "--output-directory",
      output,
    ]);
    shards = Array.from({ length: shardCount }, (_, index) =>
      readPlan(shardPath(context, index), context),
    );
    if (shards.every((shard) => shard.mutations.length <= NATIVE_MUTATIONS_PER_JOB)) break;
    shardCount++;
    if (shardCount > plan.mutations.length)
      throw new Error(`Could not bound official mutation shards for ${source}`);
  }
  validateMutationPartition(plan, shards);
  return {
    source,
    status: "planned",
    shardCount,
    jobs: shards.flatMap((shard, index) => (shard.mutations.length > 0 ? [index] : [])),
  };
}

function readCampaign(): Campaign {
  const campaign = campaignSchema.parse(readJson(campaignPath));
  if (campaign.head !== run("git", ["rev-parse", "HEAD"], root).trim())
    throw new Error("Stale mutation campaign commit");
  if (new Set(campaign.files.map((file) => file.source)).size !== campaign.files.length)
    throw new Error("Duplicate campaign source");
  return campaign;
}
function readFilePlans(file: FileCampaign) {
  const context = sourceContext(file.source);
  const plan = readPlan(parentPath(context), context);
  const shards = Array.from({ length: file.shardCount }, (_, index) =>
    readPlan(shardPath(context, index), context),
  );
  validateMutationPartition(plan, shards);
  const expected = shards.flatMap((shard, index) => (shard.mutations.length > 0 ? [index] : []));
  if (
    JSON.stringify(file.jobs) !== JSON.stringify(expected) ||
    (file.status === "notApplicable") !== (plan.mutations.length === 0) ||
    (file.status === "notApplicable" && file.shardCount !== 0)
  )
    throw new Error(`Invalid mutation campaign selection for ${file.source}`);
  return { context, plan, shards };
}

function verifyShard(
  executable: string,
  context: SourceContext,
  plan: MutationPlan,
  index: number,
  output: string,
) {
  const reportPath = join(workerOutput(context, index), "report.json");
  const report = validateMutationShardReport(readJson(reportPath), plan);
  const archive = join(workerOutput(context, index), "evidence");
  if (!existsSync(join(archive, "manifest.json")))
    throw new Error(`Missing mutation evidence archive ${archive}`);
  const io = commands(executable, context, output);
  const verificationArgs = ["--plan", shardPath(context, index), "--evidence", archive];
  validateRunVerification(
    io.jsonCommand("verify-run", [reportPath, ...verificationArgs]),
    plan,
    report,
  );
  validateMutationTrust(
    io.jsonCommand("trust", ["--report", reportPath, ...verificationArgs]),
    plan,
  );
  return reportPath;
}
function executeJob(executable: string, campaign: Campaign, input: unknown): void {
  const job = jobSchema.parse(input);
  const file = campaign.files.find((file) => file.source === job.file);
  if (!file?.jobs.includes(job.shard))
    throw new Error("Requested mutation job is not in the prepared campaign");
  const { context, shards } = readFilePlans(file);
  const plan = shards[job.shard];
  if (!plan || plan.mutations.length === 0)
    throw new Error("Requested mutation shard contains no candidates");
  const output = workerOutput(context, job.shard);
  rmSync(output, { recursive: true, force: true });
  const io = commands(executable, context, output);
  validatePlanVerification(
    io.jsonCommand("verify", ["--plan", shardPath(context, job.shard)]),
    plan,
  );
  console.error(
    `Mutating ${job.file}, shard ${job.shard}: ${plan.mutations.length} candidates with full package tests.`,
  );
  const reportPath = join(output, "report.json");
  io.command(
    "run",
    [
      "--plan",
      shardPath(context, job.shard),
      "--output",
      reportPath,
      "--no-resume",
      "--no-history",
    ],
    false,
  );
  const report = validateMutationShardReport(readJson(reportPath), plan);
  validateMutationPlan(plan, {
    projectRoot: context.directory,
    sources: sourceContext(job.file).sources,
  });
  const archive = join(context.directory, ".mutantkit/evidence", report.evidenceArchive.runID);
  if (!existsSync(join(archive, "manifest.json")))
    throw new Error(`Missing mutation evidence archive ${archive}`);
  cpSync(archive, join(output, "evidence"), { recursive: true });
  verifyShard(executable, context, plan, job.shard, output);
}
function mergeCampaign(executable: string, campaign: Campaign): void {
  for (const file of campaign.files) {
    const { context, plan, shards } = readFilePlans(file);
    const output = join(context.output, "merged");
    const io = commands(executable, context, output);
    validatePlanVerification(io.jsonCommand("verify", ["--plan", parentPath(context)]), plan);
    if (file.status === "notApplicable") {
      console.log(
        `${file.source}: not applicable (verified zero-candidate plan; no mutation score).`,
      );
      continue;
    }
    const reports = file.jobs.map((index) => {
      const shard = shards[index];
      if (!shard) throw new Error(`Missing prepared mutation shard ${index}`);
      return verifyShard(executable, context, shard, index, join(output, `shard-${index}`));
    });
    const mergedPath = join(output, "report.json");
    io.command("merge", [...reports, "--plan", parentPath(context), "--output", mergedPath]);
    const merged = validateMergedMutationReport(readJson(mergedPath), plan);
    console.log(
      `${file.source}: ${merged.results.length} complete verified results; ${JSON.stringify(merged.score)}.`,
    );
  }
  if (campaign.files.length === 0)
    console.log("No changed compiled Swift sources; mutation testing is not applicable.");
}

if (workerInput || mergeOnly) {
  const campaign = readCampaign();
  const executable = getMutantKitExecutable((command, commandArgs) =>
    run(command, commandArgs, root),
  );
  if (workerInput) executeJob(executable, campaign, JSON.parse(workerInput));
  else mergeCampaign(executable, campaign);
} else {
  if (!base) throw new Error("A mutation comparison base is required");
  const changed = run(
    "git",
    ["diff", "--name-only", "-z", "--diff-filter=ACMRT", `${base}...HEAD`, "--"],
    root,
  )
    .split("\0")
    .filter((path) => path.endsWith(".swift"));
  const selected = changed.filter((source) => {
    const directory = owningPackage(source);
    let inventory = inventories.get(directory);
    if (!inventory) {
      inventory = compiledSources(directory);
      inventories.set(directory, inventory);
    }
    return inventory.has(relative(directory, resolve(root, source)));
  });
  if (requestedFile && !selected.includes(requestedFile))
    throw new Error(`Requested file is not a changed compiled Swift source: ${requestedFile}`);
  if (listFiles) console.log(JSON.stringify(selected));
  else {
    rmSync(reportRoot, { recursive: true, force: true });
    mkdirSync(reportRoot, { recursive: true });
    const files = requestedFile ? [requestedFile] : selected;
    const executable =
      files.length > 0
        ? getMutantKitExecutable((command, commandArgs) => run(command, commandArgs, root))
        : "";
    const campaign: Campaign = {
      schemaVersion: 1,
      head: run("git", ["rev-parse", "HEAD"], root).trim(),
      files: files.map((source) => prepareSource(executable, source)),
    };
    writeFileSync(campaignPath, JSON.stringify(campaign, null, 2));
    const jobs = campaign.files.flatMap((file) =>
      file.jobs.map((shard) => ({ file: file.source, shard })),
    );
    if (prepareOnly) {
      // https://docs.github.com/en/actions/reference/limits#existing-system-limits
      if (jobs.length > 256)
        throw new Error(
          `Swift mutation campaign requires ${jobs.length} workers, exceeding GitHub Actions' 256-job matrix limit; all candidate plans are retained in ${relative(root, reportRoot)}.`,
        );
      console.log(JSON.stringify(jobs));
    } else {
      for (const job of jobs) executeJob(executable, campaign, job);
      mergeCampaign(executable, campaign);
    }
  }
}
