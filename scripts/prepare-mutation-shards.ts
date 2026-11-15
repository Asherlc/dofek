import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const maximumShardCount = 16;

// Shared files are mutated against the pure unit-shared suite. Everything else
// (root src, server, web) keeps the full mutation suite. Keep this predicate in
// sync with the `unit-shared` project in vitest.config.ts.
const sharedMutationPathPattern = /^packages\/(?!server\/|web\/|mobile\/)[^/]+\/src\//;

const excludedMutationPathPatterns = [
  /\.test\.ts$/,
  /\.cy\.ts$/,
  /test-helpers\.ts$/,
  /^packages\/server\/src\/routers\/clickhouse-integration-test-/,
  /\.d\.ts$/,
  /\.gen\.ts$/,
  /\.config\./,
  /drizzle\//,
  /src\/db\/clickhouse-migrations\.ts$/,
  /src\/db\/drizzle-schema\.ts$/,
  /src\/db\/schema\//,
  /packages\/server\/src\/types\.ts$/,
  /^packages\/training\/src\/terminology\.ts$/,
  /scripts\//,
  /^cypress\//,
  /packages\/mobile\//,
  /\.storybook\//,
  /\.stories\.ts$/,
  /^packages\/zepp\/app\.ts$/,
  /^packages\/zepp\/app-side\//,
  /^packages\/zepp\/app-service\//,
  /^packages\/zepp\/page\//,
  /^packages\/zepp\/setting\//,
];

type MutationScope = "server" | "shared";

interface MutationFileSpec {
  path: string;
  spec: string;
  weight: number;
}

function filterMutationCandidates(changedFiles: readonly string[], scope: MutationScope): string[] {
  return changedFiles.filter((file) => {
    if (!file.endsWith(".ts")) return false;
    if (excludedMutationPathPatterns.some((pattern) => pattern.test(file))) {
      return false;
    }
    const isShared = sharedMutationPathPattern.test(file);
    return scope === "shared" ? isShared : !isShared;
  });
}

function hasRuntimeDeclarations(source: string): boolean {
  const runtimeDeclarationPattern =
    /(?:^|\s)(?:export\s+default|export\s+(?:async\s+)?function|export\s+class|export\s+(?:const|let|var|enum)|(?:(?:async\s+)?function|class|const|let|var|enum)\s)/;

  for (const line of source.split("\n")) {
    if (/^[ \t]*(?:\/\/|$)/.test(line)) continue;
    if (runtimeDeclarationPattern.test(line)) return true;
  }
  return false;
}

function parseChangedLineRanges(diff: string): string[] {
  const ranges: string[] = [];
  for (const line of diff.split("\n")) {
    if (!line.startsWith("@@ ")) continue;
    const match = / \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count > 0) ranges.push(`${start}-${start + count - 1}`);
  }
  return ranges;
}

function buildWeightedShards(files: readonly MutationFileSpec[]): string[] {
  const shardCount = Math.min(files.length, maximumShardCount);
  if (shardCount === 0) return [];

  const shards: { specs: string[]; weight: number }[] = Array.from({ length: shardCount }, () => ({
    specs: [],
    weight: 0,
  }));
  const sortedFiles = [...files].sort(
    (left, right) => right.weight - left.weight || left.path.localeCompare(right.path),
  );

  for (const file of sortedFiles) {
    let target = 0;
    for (let index = 1; index < shardCount; index += 1) {
      if (shards[index].weight < shards[target].weight) target = index;
    }
    shards[target].specs.push(file.spec);
    shards[target].weight += file.weight;
  }

  return shards.filter((shard) => shard.specs.length > 0).map((shard) => shard.specs.join(","));
}

function hasColocatedTest(workspace: string, file: string): boolean {
  const testBase = file.slice(0, -".ts".length);
  return (
    existsSync(join(workspace, `${testBase}.test.ts`)) ||
    existsSync(join(workspace, `${testBase}.test.tsx`))
  );
}

function discoverMutationFiles(
  workspace: string,
  diffRange: string,
  scope: MutationScope,
): MutationFileSpec[] {
  const git = (...argumentsToPass: string[]) =>
    execFileSync("git", argumentsToPass, { cwd: workspace, encoding: "utf8" });

  const changedFiles = git("diff", "-M", "-C", "--diff-filter=AM", "--name-only", diffRange)
    .split("\n")
    .filter(Boolean);

  const mutationFiles: MutationFileSpec[] = [];
  for (const file of filterMutationCandidates(changedFiles, scope)) {
    if (!existsSync(join(workspace, file))) {
      process.stderr.write(`Skipping ${file}: file no longer exists\n`);
      continue;
    }
    if (!hasColocatedTest(workspace, file)) {
      process.stderr.write(`Skipping ${file}: no colocated Docker-free unit test\n`);
      continue;
    }
    if (!hasRuntimeDeclarations(readFileSync(join(workspace, file), "utf8"))) {
      process.stderr.write(`Skipping ${file}: no runtime declarations to mutate\n`);
      continue;
    }

    // Mutate only the lines this change added or modified. A one-line edit must
    // not surface a pre-existing file's entire coverage debt. Reindentation is
    // not a behavior change, so ignore whitespace-only diff lines.
    const ranges = parseChangedLineRanges(
      git("diff", "--ignore-space-change", "-U0", diffRange, "--", file),
    );
    if (ranges.length === 0) {
      process.stderr.write(`Skipping ${file}: no changed lines to mutate\n`);
      continue;
    }

    const weight = ranges.reduce((total, range) => {
      const [start, end] = range.split("-").map(Number);
      return total + end - start + 1;
    }, 0);

    mutationFiles.push({
      path: file,
      spec: ranges.map((range) => `${file}:${range}`).join(","),
      weight,
    });
  }

  return mutationFiles;
}

function main() {
  const { values } = parseArgs({
    options: {
      "diff-range": { type: "string" },
      scope: { type: "string" },
      workspace: { type: "string" },
    },
    allowPositionals: false,
  });

  const diffRange = values["diff-range"];
  const scope = values.scope;
  if (!diffRange) throw new Error("--diff-range is required");
  if (scope !== "shared" && scope !== "server") {
    throw new Error("--scope must be shared or server");
  }

  const workspace = values.workspace ?? process.cwd();
  const shards = buildWeightedShards(discoverMutationFiles(workspace, diffRange, scope));
  process.stdout.write(`${JSON.stringify(shards)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
