import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const durationSchema = z.number().finite().nonnegative();
const portableFileSchema = z
  .string()
  .min(1)
  .refine(
    (file) =>
      !file.includes("\\") &&
      !file.includes(":") &&
      !file.includes("\0") &&
      !file.startsWith("/") &&
      file.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Expected a portable repository-relative file identity",
  );
const keySchema = z
  .string()
  .refine(
    (key) => key.startsWith("integration:") && portableFileSchema.safeParse(key.slice(12)).success,
    "Expected integration:<portable repository-relative file>",
  );
const inventorySchema = z
  .array(keySchema)
  .refine((keys) => new Set(keys).size === keys.length, "Duplicate integration identities");
const provenanceSchema = z
  .object({
    sourceSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable(),
    repository: z.string().min(1).nullable(),
    runId: z.number().int().positive().nullable(),
    runAttempt: z.number().int().positive().nullable(),
    vitestVersion: z.string().min(1),
    source: z.string().min(1),
  })
  .passthrough();
export const timingBaselineSchema = z
  .object({
    schemaVersion: z.literal(1),
    provenance: provenanceSchema,
    files: z
      .array(
        z
          .object({
            project: z.literal("integration"),
            file: portableFileSchema,
            durationMs: durationSchema,
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    const keys = data.files.map((row) => row.file);
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: "custom", message: "Duplicate baseline identities" });
    if (!data.files.some((row) => row.durationMs > 0))
      ctx.addIssue({ code: "custom", message: "Baseline requires a positive measured duration" });
  });
export const timingAssignmentSchema = z
  .object({
    schemaVersion: z.literal(2),
    assignmentId: z.uuid(),
    assignedAt: z.number().int().positive(),
    provenance: provenanceSchema,
    index: z.number().int().positive(),
    count: z.number().int().positive(),
    inventory: inventorySchema,
    selected: inventorySchema,
    estimated: inventorySchema,
    baselineSha256: z.string().regex(/^[a-f0-9]{64}$/),
    cacheEnabled: z.boolean(),
    cacheExistedBefore: z.boolean(),
    bins: z.array(
      z.object({ durationMs: durationSchema, fileCount: z.number().int().nonnegative() }),
    ),
  })
  .superRefine((data, ctx) => {
    if (data.index > data.count || data.bins.length !== data.count)
      ctx.addIssue({ code: "custom", message: "Invalid shard index/count/bins" });
    if ([...data.selected, ...data.estimated].some((key) => !data.inventory.includes(key)))
      ctx.addIssue({ code: "custom", message: "Assignment keys outside discovered inventory" });
    if (
      data.bins.reduce((sum, bin) => sum + bin.fileCount, 0) !== data.inventory.length ||
      data.bins[data.index - 1]?.fileCount !== data.selected.length
    )
      ctx.addIssue({ code: "custom", message: "Assignment counts do not match inventory" });
  });
type Assignment = z.infer<typeof timingAssignmentSchema>;
const completedTimingSchema = z.object({
  schemaVersion: z.literal(1),
  assignmentId: z.uuid(),
  provenance: provenanceSchema,
  index: z.number().int().positive(),
  count: z.number().int().positive(),
  baselineSha256: z.string().regex(/^[a-f0-9]{64}$/),
  runStartedAt: z.number().int().positive(),
  runFinishedAt: z.number().int().positive(),
  results: z.array(
    z.tuple([
      keySchema,
      z.object({
        duration: durationSchema,
        failed: z.literal(false),
        lastRun: z.number().int().positive(),
      }),
    ]),
  ),
});

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}
/** Match the checkout policy: PR head revision, otherwise the triggering revision. */
export function integrationTimingSourceSha(environment: NodeJS.ProcessEnv): string | null {
  if (environment.GITHUB_EVENT_NAME !== "pull_request") return environment.GITHUB_SHA ?? null;
  if (!environment.GITHUB_EVENT_PATH)
    throw new Error("GITHUB_EVENT_PATH is required to identify the checked-out pull-request head");
  return z
    .object({
      pull_request: z.object({ head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }) }),
    })
    .parse(readJson(environment.GITHUB_EVENT_PATH)).pull_request.head.sha;
}
function sameKeys(actual: string[], expected: string[], label: string): void {
  if (
    new Set(actual).size !== actual.length ||
    JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())
  )
    throw new Error(
      `${label}: duplicate, missing or foreign integration keys; rerun all four successful shards`,
    );
}
function checkAssignment(assignment: Assignment, environment: NodeJS.ProcessEnv): void {
  if (assignment.count !== 4) throw new Error("Timing refresh requires exactly four shards");
  if (assignment.cacheExistedBefore || !assignment.cacheEnabled)
    throw new Error("Timing cache is stale/preexisting or disabled; rerun on a fresh CI runner");
  const provenance = assignment.provenance;
  if (
    !provenance.sourceSha ||
    !provenance.repository ||
    !provenance.runId ||
    !provenance.runAttempt
  )
    throw new Error("Timing export requires GitHub source/run/attempt provenance");
  if (environment.GITHUB_ACTIONS === "true") {
    for (const [field, key] of [
      ["sourceSha", "GITHUB_SHA"],
      ["repository", "GITHUB_REPOSITORY"],
      ["runId", "GITHUB_RUN_ID"],
      ["runAttempt", "GITHUB_RUN_ATTEMPT"],
    ] as const)
      if (
        String(provenance[field]) !==
        (field === "sourceSha" ? integrationTimingSourceSha(environment) : environment[key])
      )
        throw new Error(`Timing provenance mismatch: ${key}`);
  }
}
/** Validate our reporter artifact; Vitest's private on-disk cache format is never consumed. */
export function checkIntegrationTimingResults(value: unknown, assignment: Assignment) {
  const cache = completedTimingSchema.parse(value);
  if (
    cache.assignmentId !== assignment.assignmentId ||
    cache.index !== assignment.index ||
    cache.count !== assignment.count ||
    cache.baselineSha256 !== assignment.baselineSha256 ||
    JSON.stringify(cache.provenance) !== JSON.stringify(assignment.provenance)
  )
    throw new Error("Timing completion assignment/provenance mismatch");
  if (
    cache.runStartedAt > assignment.assignedAt ||
    cache.runFinishedAt < assignment.assignedAt ||
    cache.runFinishedAt < cache.runStartedAt ||
    cache.results.some(
      ([, result]) => result.lastRun < cache.runStartedAt || result.lastRun > cache.runFinishedAt,
    )
  )
    throw new Error("Timing cache has no complete current-run result");
  sameKeys(
    cache.results.map(([key]) => key),
    assignment.selected,
    "Timing cache",
  );
  return cache;
}

/** Export one fresh successful shard, or merge all four exports into a reviewable baseline. */
export function runIntegrationTimingCommand(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const [command, target, ...directories] = args;
  if (!target || (command !== "export" && command !== "merge"))
    throw new Error(
      "Usage: pnpm tsx scripts/update-integration-test-timings.ts export <shard-directory> | merge <output.json> <four shard-directories>",
    );
  if (command === "export") {
    if (directories.length) throw new Error("Export accepts exactly one shard directory");
    const assignment = timingAssignmentSchema.parse(readJson(join(target, "assignment.json")));
    checkAssignment(assignment, environment);
    if (environment.GITHUB_ACTIONS !== "true")
      throw new Error("Only successful fresh GitHub Actions shards are eligible timing exports");
    if (!existsSync(join(target, "completed-results.json")))
      throw new Error(
        "No eligible complete timing results; run every assigned file successfully with a fresh enabled Vitest cache. Partial, failed or interrupted runs cannot be exported.",
      );
    const cache = checkIntegrationTimingResults(
      readJson(join(target, "completed-results.json")),
      assignment,
    );
    writeFileSync(join(target, "results.json"), `${JSON.stringify(cache, null, 2)}\n`);
    return;
  }
  if (directories.length !== 4)
    throw new Error("Timing refresh requires all four shard directories");
  const shards = directories
    .map((directory) => {
      const assignment = timingAssignmentSchema.parse(readJson(join(directory, "assignment.json")));
      checkAssignment(assignment, environment);
      return {
        assignment,
        cache: checkIntegrationTimingResults(readJson(join(directory, "results.json")), assignment),
      };
    })
    .sort((a, b) => a.assignment.index - b.assignment.index);
  const first = shards[0]?.assignment;
  if (!first) throw new Error("Timing refresh requires all four shards");
  const indices = shards.map((shard) => shard.assignment.index);
  if (JSON.stringify(indices) !== "[1,2,3,4]")
    throw new Error("Missing or duplicate integration shard");
  for (const { assignment } of shards) {
    if (
      JSON.stringify(assignment.provenance) !== JSON.stringify(first.provenance) ||
      assignment.baselineSha256 !== first.baselineSha256
    )
      throw new Error("Incoherent timing source/run/attempt/runtime/baseline provenance");
    sameKeys(assignment.inventory, first.inventory, "Discovered inventory");
  }
  const rows = shards.flatMap(({ cache }) => cache.results);
  sameKeys(
    rows.map(([key]) => key),
    first.inventory,
    "Complete four-shard union",
  );
  const baseline = timingBaselineSchema.parse({
    schemaVersion: 1,
    provenance: {
      ...first.provenance,
      source: "Successful complete four-shard Vitest public cache results (whole-suite durations)",
      baselineSha256: first.baselineSha256,
      inventory: first.inventory,
      shards: shards.map(({ assignment }) => assignment),
    },
    files: rows
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, result]) => ({
        project: "integration",
        file: key.slice(12),
        durationMs: result.duration,
      })),
  });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(baseline, null, 2)}\n`, { flag: "wx" });
  renameSync(temporary, target);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  runIntegrationTimingCommand(process.argv.slice(2));
