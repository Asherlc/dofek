import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const workspace = process.cwd();
const temporaryDirectories: string[] = [];

function createGitFixture() {
  const directory = mkdtempSync(join(tmpdir(), "release-mutation-selection-"));
  temporaryDirectories.push(directory);
  const git = (...argumentsToPass: string[]) =>
    execFileSync("git", argumentsToPass, { cwd: directory, encoding: "utf8" }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.email", "release-fixture@example.test");
  git("config", "user.name", "Release fixture");
  mkdirSync(join(directory, ".release-tools", "scripts"), { recursive: true });
  copyFileSync(
    resolve(workspace, "scripts/prepare-mutation-shards.ts"),
    join(directory, ".release-tools/scripts/prepare-mutation-shards.ts"),
  );
  mkdirSync(join(directory, "packages/format/src"), { recursive: true });
  mkdirSync(join(directory, "src"), { recursive: true });
  writeFileSync(join(directory, "packages/format/src/value.ts"), "export const value = 1;\n");
  writeFileSync(join(directory, "packages/format/src/value.test.ts"), "export {};\n");
  writeFileSync(join(directory, "src/server-value.ts"), "export const serverValue = 1;\n");
  writeFileSync(join(directory, "src/server-value.test.ts"), "export {};\n");
  git("add", "--all");
  git("commit", "--message", "parent source");
  const parentSha = git("rev-parse", "HEAD");
  writeFileSync(join(directory, "packages/format/src/value.ts"), "export const value = 2;\n");
  writeFileSync(join(directory, "src/server-value.ts"), "export const serverValue = 2;\n");
  git("add", "--all");
  git("commit", "--message", "selected release source");
  return { directory, parentSha };
}

function workflowShardStep(path: string): string {
  const workflow = parse(readFileSync(path, "utf8")) as {
    jobs: Record<string, { steps?: Array<{ id?: string; run?: string }> }>;
  };
  const step = workflow.jobs["mutation-shared-prep"]?.steps?.find(({ id }) => id === "shard") ??
    workflow.jobs["mutation-prep"]?.steps?.find(({ id }) => id === "shard");
  if (!step?.run) throw new Error(`Could not find executable mutation selection step in ${path}`);
  return step.run;
}

function runSelection(path: string) {
  const fixture = createGitFixture();
  const bin = join(fixture.directory, "bin");
  mkdirSync(bin);
  const outputPath = join(fixture.directory, "output");
  writeFileSync(outputPath, "");
  const tsx = resolve(workspace, "node_modules/.bin/tsx");
  writeFileSync(
    join(bin, "pnpm"),
    `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(tsx)}, [args[2], ...args.slice(3)], { cwd: process.cwd(), encoding: 'utf8', env: process.env });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status ?? 1);
`,
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", workflowShardStep(path)], {
    cwd: fixture.directory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      EVENT_NAME: "workflow_dispatch",
      PR_BASE_SHA: "",
      MUTATION_BASE_SHA: fixture.parentSha,
      CONTROL_COMMIT_SHA: "c".repeat(40),
      GITHUB_OUTPUT: outputPath,
    },
  });
  return { output: readFileSync(outputPath, "utf8"), result };
}

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

describe("historical manual release mutation selection", () => {
  it.each([
    [".github/workflows/check-shared.yml", "packages/format/src/value.ts"],
    [".github/workflows/check-server.yml", "src/server-value.ts"],
  ] as const)("selects %s changes relative to the chosen source parent", (workflowPath, file) => {
    const { output, result } = runSelection(resolve(workspace, workflowPath));
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(output).toContain(`shards=[\"${file}:1-1\"]`);
  });
});
