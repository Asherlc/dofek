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
export const baseSha = gitFixtureCommand("rev-parse", "HEAD");
writeFileSync(join(gitFixtureRoot, "release.txt"), "prior release\n");
gitFixtureCommand("commit", "-am", "prior release");
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
else if (args.some((arg) => arg.includes('/actions/runs/') && arg.endsWith('/jobs?per_page=100'))) {
  process.stdout.write(process.env.GH_ACTION_JOBS);
}
else if (args.some((arg) => arg.includes('/actions/runs/') && arg.includes('/attempts/'))) {
  process.stdout.write(process.env.GH_ACTION_ATTEMPT);
}
else if (args.some((arg) => arg.includes('/actions/runs/'))) {
  process.stdout.write(process.env.GH_ACTION_RUN);
}
else if (args.some((arg) => arg.endsWith('/statuses')) && args.includes('--method')) {
  const request = JSON.parse(input);
  if ((request.description || '').length > 140) { console.error('description exceeds 140 characters'); process.exit(1); }
  const deploymentId = args.find((arg) => arg.endsWith('/statuses')).split('/').at(-2);
  if (deploymentId === process.env.GH_STATUS_FAIL_FOR) process.exit(1);
  process.stdout.write(JSON.stringify({ state: request.state, description: request.description }));
}
else if (args.some((arg) => arg.endsWith('/deployments'))) {
  const request = JSON.parse(input);
  process.stdout.write(JSON.stringify({ id: 77, node_id: 'D_fixture', sha: request.ref, environment: request.environment, task: request.task, payload: request.payload }));
} else if (args.some((arg) => arg.includes('/deployments/') && Number.isInteger(Number(arg.split('/').at(-1))))) {
  const deploymentId = args.find((arg) => arg.includes('/deployments/')).split('/').at(-1);
  process.stdout.write(process.env['GH_DEPLOYMENT_' + deploymentId] || process.env.GH_DEPLOYMENT);
} else if (args.some((arg) => arg.endsWith('/statuses'))) {
  const deploymentId = args.find((arg) => arg.endsWith('/statuses')).split('/').at(-2);
  process.stdout.write(process.env['GH_STATUSES_' + deploymentId] || process.env.GH_STATUSES);
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
else if (args[0] === 'ps' && process.env.DOCKER_PS_EXIT) {
  console.error('mock docker ps failure');
  process.exit(Number(process.env.DOCKER_PS_EXIT));
}
else if (args[0] === 'inspect' && args.includes('task')) process.stdout.write(JSON.stringify({image:'ghcr.io/owner/dofek@' + process.env.CANDIDATE_DIGEST,state:'running'}));
else process.exit(2);
`,
  );
  writeFileSync(
    join(bin, "ssh"),
    `#!/usr/bin/env node
const command = process.argv.slice(2).join(' ');
if (process.env.SSH_LOG) require('node:fs').appendFileSync(process.env.SSH_LOG, command + '\\n');
const query = process.argv.slice(2).at(-1);
if (process.env.SSH_WORKER_PS_EXIT && query.includes('org.opencontainers.image.revision') && query.includes('dofek_worker')) {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync('bash', ['-c', query], { encoding: 'utf8', env: process.env });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
const live = process.env.LIVE_SHA + ' ghcr.io/owner/dofek@' + process.env.LIVE_DIGEST + ' running\\n';
const webImage = process.env.WEB_SPEC_IMAGE ?? ('ghcr.io/owner/dofek@' + process.env.LIVE_DIGEST);
if (command.includes('service ls')) process.stdout.write('dofek_web\\ndofek_worker\\n');
else if (command.includes('service inspect') && command.includes('ContainerSpec.Image')) process.stdout.write(command.includes('dofek_worker') ? (process.env.WORKER_SPEC_IMAGE ?? webImage) : webImage);
else if (command.includes('service inspect') && command.includes('Replicated.Replicas')) process.stdout.write(process.env.WORKER_DESIRED_REPLICAS ?? '0');
else if (command.includes('service ps') && command.includes('desired-state=running')) process.stdout.write(process.env.WORKER_RUNNING_TASKS ?? '');
else if (command.includes('docker ps') && command.includes('{{.ID}}')) process.stdout.write(process.env.WORKER_RUNNING_CONTAINERS ?? '');
else if (command.includes('org.opencontainers.image.revision')) process.stdout.write(command.includes('dofek_worker') ? (process.env.WORKER_LIVE ?? live) : live);
else process.stdout.write(live);
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

export function failedServerReceipt(): ReturnType<typeof record> {
  const pending = record(
    parentSha,
    "PENDING",
    {
      source_sha: parentSha,
      image_digest: liveDigest,
      run_id: "124",
      run_attempt: "1",
      run_url: "https://github.com/owner/dofek/actions/runs/124/attempts/1",
    },
    "Server source awaiting stack verification",
  );
  pending.databaseId = 99;
  return pending;
}

export function failedRecoveryEnvironment(
  directory: string,
  logPath: string,
  overrides: Record<string, string> = {},
  jobName = "Deploy Server Production / Deploy Web Stack / Deploy Web Stack",
): Record<string, string> {
  const priorRun = {
    id: 124,
    run_attempt: 1,
    head_sha: baseSha,
    status: "completed",
    conclusion: "failure",
  };
  const failedJob = {
    id: 125,
    run_id: 124,
    run_attempt: 1,
    head_sha: baseSha,
    name: jobName,
    status: "completed",
    conclusion: "failure",
  };
  return {
    GH_TOKEN: "fixture",
    GH_LOG: logPath,
    GH_HISTORY: history([
      failedServerReceipt(),
      record(baseSha, "SUCCESS", { source_sha: baseSha, image_digest: candidateDigest }),
    ]),
    GH_ACTION_RUN: JSON.stringify(priorRun),
    GH_ACTION_ATTEMPT: JSON.stringify(priorRun),
    GH_ACTION_JOBS: JSON.stringify([{ total_count: 1, jobs: [failedJob] }]),
    RUNNER_TEMP: directory,
    SOURCE_SHA: headSha,
    IMAGE_TAG: "sha-test",
    STACK_NAME: "dofek",
    SERVER_HOST: "fixture-host",
    SSH_USER: "ubuntu",
    REPOSITORY: "owner/dofek",
    RUN_ID: "400",
    RUN_ATTEMPT: "1",
    RUN_URL: "https://github.com/owner/dofek/actions/runs/400/attempts/1",
    ENVIRONMENT_URL: "https://dofek.fit",
    CANDIDATE_DIGEST: candidateDigest,
    LIVE_SHA: parentSha,
    LIVE_DIGEST: liveDigest,
    RECOVER_FAILED_DEPLOYMENT_ID: "99",
    ...overrides,
  };
}

export interface WorkflowStepConclusion {
  name: string;
  conclusion: string;
}

export function preMigrationFailureSteps(): WorkflowStepConclusion[] {
  return [
    { name: "Wait for migration readers and writers to stop", conclusion: "success" },
    { name: "Wait for pre-migration web convergence", conclusion: "failure" },
    { name: "Run migrations", conclusion: "skipped" },
  ];
}

export function stoppedWorkerFailedReceipt(): ReturnType<typeof record> {
  const pending = failedServerReceipt();
  pending.payload = {
    ...(pending.payload as Record<string, unknown>),
    image_digest: `sha256:${"d".repeat(64)}`,
  };
  return pending;
}

export function stoppedWorkerRecoveryEnvironment(
  directory: string,
  logPath: string,
  overrides: Record<string, string> = {},
  steps: WorkflowStepConclusion[] | null = preMigrationFailureSteps(),
): Record<string, string> {
  const base = failedRecoveryEnvironment(directory, logPath);
  const failedJob = {
    id: 125,
    run_id: 124,
    run_attempt: 1,
    head_sha: baseSha,
    name: "Deploy Server Production / Deploy Web Stack / Deploy Web Stack",
    status: "completed",
    conclusion: "failure",
    ...(steps === null ? {} : { steps }),
  };
  return {
    ...base,
    GH_HISTORY: history([
      stoppedWorkerFailedReceipt(),
      record(baseSha, "SUCCESS", { source_sha: baseSha, image_digest: liveDigest }),
    ]),
    GH_ACTION_RUN: JSON.stringify({
      id: 124,
      run_attempt: 1,
      head_sha: baseSha,
      status: "completed",
      conclusion: "failure",
    }),
    GH_ACTION_ATTEMPT: JSON.stringify({
      id: 124,
      run_attempt: 1,
      head_sha: baseSha,
      status: "completed",
      conclusion: "failure",
    }),
    GH_ACTION_JOBS: JSON.stringify([{ total_count: 1, jobs: [failedJob] }]),
    LIVE_SHA: baseSha,
    LIVE_DIGEST: liveDigest,
    WEB_SPEC_IMAGE: `ghcr.io/owner/dofek@${liveDigest}`,
    WORKER_SPEC_IMAGE: `ghcr.io/owner/dofek@${liveDigest}`,
    WORKER_LIVE: "",
    WORKER_DESIRED_REPLICAS: "0",
    WORKER_RUNNING_CONTAINERS: "",
    WORKER_RUNNING_TASKS: "",
    ...overrides,
  };
}

export interface StoppedWorkerRecoveryFixture {
  result: ReturnType<typeof runWorkflowStep>;
  output: string;
  calls: Array<{ args: string[]; input: string }>;
  sshCommands: string[];
}

export function runStoppedWorkerRecovery(
  script: string,
  overrides: Record<string, string> = {},
  steps: WorkflowStepConclusion[] | null = preMigrationFailureSteps(),
): StoppedWorkerRecoveryFixture {
  const directory = mkdtempSync(join(tmpdir(), "server-publication-pre-migration-"));
  try {
    const bin = fixtureBin(directory);
    const logPath = join(directory, "gh.jsonl");
    const sshLog = join(directory, "ssh.log");
    const outputPath = join(directory, "output");
    const result = runWorkflowStep(
      script,
      bin,
      outputPath,
      stoppedWorkerRecoveryEnvironment(directory, logPath, { SSH_LOG: sshLog, ...overrides }, steps),
    );
    const readLines = (path: string) =>
      existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
    return {
      result,
      output: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "",
      calls: readLines(logPath).map((line) => JSON.parse(line)),
      sshCommands: readLines(sshLog),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export interface StoppedWorkerRejection {
  label: string;
  overrides?: Record<string, string>;
  steps?: WorkflowStepConclusion[] | null;
  error: string;
}

export const stoppedWorkerRejections: StoppedWorkerRejection[] = [
  { label: "missing step evidence", steps: null, error: "no step evidence for pre-migration recovery" },
  {
    label: "readers and writers not stopped",
    steps: [
      { name: "Wait for migration readers and writers to stop", conclusion: "failure" },
      { name: "Wait for pre-migration web convergence", conclusion: "failure" },
      { name: "Run migrations", conclusion: "skipped" },
    ],
    error: 'step "Wait for migration readers and writers to stop" concluded failure',
  },
  {
    label: "pre-migration web convergence succeeded",
    steps: [
      { name: "Wait for migration readers and writers to stop", conclusion: "success" },
      { name: "Wait for pre-migration web convergence", conclusion: "success" },
      { name: "Run migrations", conclusion: "skipped" },
    ],
    error: 'step "Wait for pre-migration web convergence" concluded success',
  },
  {
    label: "migrations ran",
    steps: [
      { name: "Wait for migration readers and writers to stop", conclusion: "success" },
      { name: "Wait for pre-migration web convergence", conclusion: "failure" },
      { name: "Run migrations", conclusion: "success" },
    ],
    error: 'step "Run migrations" concluded success',
  },
  {
    label: "automatic admission without a recovery ID",
    overrides: { RECOVER_FAILED_DEPLOYMENT_ID: "" },
    error: "live web and worker identities cannot be reconciled",
  },
  { label: "a still-desired worker", overrides: { WORKER_DESIRED_REPLICAS: "2" }, error: "still desires" },
  {
    label: "a running worker container",
    overrides: { WORKER_RUNNING_CONTAINERS: "worker-task\n" },
    error: "running container",
  },
  {
    label: "a desired-running worker task",
    overrides: { WORKER_RUNNING_TASKS: "worker-task\n" },
    error: "desired-running task",
  },
  {
    label: "a worker service spec on another image",
    overrides: { WORKER_SPEC_IMAGE: `ghcr.io/owner/dofek@sha256:${"e".repeat(64)}` },
    error: "worker service spec image",
  },
  {
    label: "a web service spec on another image",
    overrides: { WEB_SPEC_IMAGE: `ghcr.io/owner/dofek@sha256:${"e".repeat(64)}` },
    error: "web service spec image",
  },
  {
    label: "a live web source behind the verified baseline",
    overrides: { LIVE_SHA: parentSha },
    error: "does not match the last verified successful server receipt",
  },
  {
    label: "a live web digest behind the verified baseline",
    overrides: { LIVE_DIGEST: candidateDigest },
    error: "does not match the last verified successful server receipt",
  },
  { label: "a non-descendant candidate", overrides: { SOURCE_SHA: parentSha }, error: "must be a strict descendant" },
];
