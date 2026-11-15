import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const repositoryRoot = process.cwd();
const gitFixtureRoot = mkdtempSync(join(tmpdir(), "release-publication-git-"));
const gitFixtureCommand = (...args: string[]) =>
  execFileSync("git", args, { cwd: gitFixtureRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
gitFixtureCommand("init", "--initial-branch=main");
gitFixtureCommand("config", "user.name", "Release fixture");
gitFixtureCommand("config", "user.email", "release-fixture@example.test");
writeFileSync(join(gitFixtureRoot, "release.txt"), "verified parent\n");
gitFixtureCommand("add", "release.txt");
gitFixtureCommand("commit", "-m", "verified parent");
export const parentSha = gitFixtureCommand("rev-parse", "HEAD");
writeFileSync(join(gitFixtureRoot, "release.txt"), "candidate\n");
gitFixtureCommand("commit", "-am", "candidate");
export const headSha = gitFixtureCommand("rev-parse", "HEAD");
afterAll(() => rmSync(gitFixtureRoot, { recursive: true, force: true }));
export const candidateDigest = `sha256:${"c".repeat(64)}`;
export const liveDigest = `sha256:${"b".repeat(64)}`;
export const runtime = "ee28bafccebbd4101e0003e134c554ed38303780";
export const updateId = "47a9ab69-6103-6981-398b-a90d59a49a8a";

const workflowSchema = z.object({
  jobs: z.record(
    z.string(),
    z.object({
      steps: z
        .array(
          z.object({
            id: z.string().optional(),
            name: z.string().optional(),
            run: z.string().optional(),
          }),
        )
        .optional(),
    }),
  ),
});

export function readWorkflow(path: string) {
  return workflowSchema.parse(parse(readFileSync(path, "utf8")));
}

export function workflowStep(path: string, jobId: string, stepId: string): string {
  const step = readWorkflow(path).jobs[jobId]?.steps?.find(({ id }) => id === stepId);
  if (!step?.run) throw new Error(`Could not find executable workflow step ${jobId}.${stepId}`);
  return step.run;
}

export function fixtureBin(directory: string): string {
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const gitBinary = process.platform === "win32" ? "git.exe" : "git";
  const realGit = process.env.PATH?.split(delimiter).map((path) => join(path, gitBinary)).find(existsSync);
  if (!realGit) throw new Error("Could not find Git on PATH");
  symlinkSync(realGit, join(bin, "git"));
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.GH_LOG, JSON.stringify({ args, input }) + '\\n');
if (args.includes('graphql')) {
  const variables = JSON.parse(input).variables;
  process.stdout.write(variables.after ? process.env.GH_HISTORY_NEXT || process.env.GH_HISTORY : process.env.GH_HISTORY);
}
else if (args.some((arg) => arg.endsWith('/statuses')) && args.includes('--method')) {
  const request = JSON.parse(input);
  if ((request.description || '').length > 140) { console.error('description exceeds 140 characters'); process.exit(1); }
  process.stdout.write(JSON.stringify({ state: request.state, description: request.description }));
}
else if (args.some((arg) => arg.endsWith('/deployments'))) {
  const request = JSON.parse(input);
  process.stdout.write(JSON.stringify({ id: 77, node_id: 'D_fixture', sha: request.ref, environment: request.environment, task: request.task, payload: request.payload }));
} else if (args.some((arg) => arg.includes('/deployments/') && Number.isInteger(Number(arg.split('/').at(-1))))) {
  process.stdout.write(process.env.GH_DEPLOYMENT);
} else if (args.some((arg) => arg.endsWith('/statuses'))) {
  process.stdout.write(process.env.GH_STATUSES);
} else {
  const request = JSON.parse(input);
  process.stdout.write(JSON.stringify({ state: request.state }));
}
`,
  );
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'buildx') process.stdout.write(JSON.stringify({digest:process.env.CANDIDATE_DIGEST}));
else if (args[0] === 'service' && args[1] === 'inspect') {
  const format = args.at(-1);
  process.stdout.write(format.includes('Replicated.Replicas') ? '1' : 'ghcr.io/owner/dofek@' + process.env.CANDIDATE_DIGEST);
} else if (args[0] === 'service' && args[1] === 'ps') process.stdout.write('task-fixture');
else if (args[0] === 'inspect' && args.includes('task')) process.stdout.write(JSON.stringify({image:'ghcr.io/owner/dofek@' + process.env.CANDIDATE_DIGEST,state:'running'}));
else process.exit(2);
`,
  );
  writeFileSync(
    join(bin, "ssh"),
    `#!/usr/bin/env node
const command = process.argv.slice(2).join(' ');
if (command.includes('service ls')) process.stdout.write('dofek_web\\ndofek_worker\\n');
else process.stdout.write(process.env.LIVE_SHA + ' ghcr.io/owner/dofek@' + process.env.LIVE_DIGEST + ' running\\n');
`,
  );
  writeFileSync(
    join(bin, "pnpm"),
    `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const nodePath = require('node:path');
const args = process.argv.slice(2);
if (args.includes('verify-deploy-image.ts')) {
  const result = spawnSync(nodePath.resolve('node_modules/.bin/tsx'), ['scripts/verify-deploy-image.ts', ...args.slice(-2)], { stdio: 'inherit', env: process.env });
  process.exit(result.status ?? 1);
}
const fs = require('node:fs');
const path = require('node:path').join(process.env.RUNNER_TEMP, 'dofek-ota-preflight', 'xprem-update-metadata.json');
fs.mkdirSync(require('node:path').dirname(path), { recursive: true });
fs.writeFileSync(path, JSON.stringify([{ id: process.env.FIXTURE_UPDATE_ID, runtimeVersion: process.env.FIXTURE_RUNTIME, platform: 'ios', branch: 'main' }]));
`,
  );
  for (const name of ["gh", "docker", "ssh", "pnpm"]) chmodSync(join(bin, name), 0o755);
  return bin;
}

export function history(nodes: unknown[] = [], hasNextPage = false, endCursor: string | null = null): string {
  return JSON.stringify({
    data: { repository: { deployments: { nodes, pageInfo: { hasNextPage, endCursor } } } },
  });
}

export function record(
  sourceSha: string,
  state: string,
  payload: Record<string, unknown> | string,
  description = "",
) {
  return {
    databaseId: 41,
    task: "server-stack-publish",
    commitOid: sourceSha,
    payload,
    latestStatus: { state, description },
  };
}

export function graphqlStringPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(JSON.stringify(payload));
}

export function runWorkflowStep(
  script: string,
  bin: string,
  outputPath: string,
  env: Record<string, string>,
) {
  return spawnSync("bash", ["-euo", "pipefail", "-c", script], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      GITHUB_OUTPUT: outputPath,
      GIT_DIR: join(gitFixtureRoot, ".git"),
      GIT_WORK_TREE: gitFixtureRoot,
      IMAGE_REF: `ghcr.io/owner/dofek@${env.CANDIDATE_DIGEST ?? candidateDigest}`,
      ...env,
    },
  });
}
