import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repositoryRoot = process.cwd();
const git = (...args: string[]) =>
  String(
    spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).stdout,
  ).trim();
const headSha = git("rev-parse", "HEAD");
const parentSha = git("rev-parse", "HEAD^");
const candidateDigest = `sha256:${"c".repeat(64)}`;
const liveDigest = `sha256:${"b".repeat(64)}`;
const runtime = "ee28bafccebbd4101e0003e134c554ed38303780";
const updateId = "47a9ab69-6103-6981-398b-a90d59a49a8a";

function workflowStep(path: string, jobId: string, stepId: string): string {
  const document = parse(readFileSync(path, "utf8")) as {
    jobs: Record<string, { steps?: Array<{ id?: string; run?: string }> }>;
  };
  const step = document.jobs[jobId]?.steps?.find(({ id }) => id === stepId);
  if (!step?.run) throw new Error(`Could not find executable workflow step ${jobId}.${stepId}`);
  return step.run;
}

function fixtureBin(directory: string): string {
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
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

function history(nodes: unknown[] = [], hasNextPage = false, endCursor: string | null = null): string {
  return JSON.stringify({
    data: { repository: { deployments: { nodes, pageInfo: { hasNextPage, endCursor } } } },
  });
}

function record(sourceSha: string, state: string, payload: Record<string, unknown>, description = "") {
  return {
    databaseId: 41,
    task: "server-stack-publish",
    commitOid: sourceSha,
    payload,
    latestStatus: { state, description },
  };
}

function runWorkflowStep(
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
      IMAGE_REF: `ghcr.io/owner/dofek@${env.CANDIDATE_DIGEST ?? candidateDigest}`,
      ...env,
    },
  });
}

describe("server publication workflow step", () => {
  const script = workflowStep(".github/workflows/deploy-web-environment.yml", "check", "publication");

  it("reconciles a live server identity and records a durable intent before Terraform", () => {
    const directory = mkdtempSync(join(tmpdir(), "server-publication-step-"));
    try {
      const bin = fixtureBin(directory);
      const outputPath = join(directory, "output");
      const logPath = join(directory, "gh.jsonl");
      const result = runWorkflowStep(script, bin, outputPath, {
        GH_TOKEN: "fixture",
        GH_LOG: logPath,
        GH_HISTORY: history(),
        RUNNER_TEMP: directory,
        SOURCE_SHA: headSha,
        IMAGE_TAG: "sha-test",
        STACK_NAME: "dofek",
        SERVER_HOST: "fixture-host",
        SSH_USER: "ubuntu",
        REPOSITORY: "owner/dofek",
        RUN_ID: "123",
        RUN_ATTEMPT: "1",
        RUN_URL: "https://github.com/owner/dofek/actions/runs/123/attempts/1",
        CANDIDATE_DIGEST: candidateDigest,
        LIVE_SHA: parentSha,
        LIVE_DIGEST: liveDigest,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(outputPath, "utf8")).toContain("decision=publish");
      const calls = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(calls.some((call) => call.args.includes("repos/owner/dofek/deployments"))).toBe(true);
      const statuses = calls.filter((call) => call.args.some((arg: string) => arg.endsWith("/statuses")));
      expect(JSON.parse(statuses[0].input).state).toBe("success");
      expect(JSON.parse(statuses[1].input).state).toBe("pending");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("blocks an older candidate while a newer server intent remains unresolved", () => {
    const directory = mkdtempSync(join(tmpdir(), "server-publication-pending-"));
    try {
      const bin = fixtureBin(directory);
      const logPath = join(directory, "gh.jsonl");
      const outputPath = join(directory, "output");
      const result = runWorkflowStep(script, bin, outputPath, {
        GH_TOKEN: "fixture",
        GH_LOG: logPath,
        GH_HISTORY: history([record(headSha, "PENDING", { source_sha: headSha, image_digest: liveDigest })]),
        SOURCE_SHA: parentSha,
        IMAGE_TAG: "sha-old",
        STACK_NAME: "dofek",
        SERVER_HOST: "fixture-host",
        SSH_USER: "ubuntu",
        REPOSITORY: "owner/dofek",
        RUN_ID: "124",
        RUN_ATTEMPT: "1",
        RUN_URL: "https://github.com/owner/dofek/actions/runs/124/attempts/1",
        CANDIDATE_DIGEST: candidateDigest,
        LIVE_SHA: headSha,
        LIVE_DIGEST: liveDigest,
      });
      expect(result.status).not.toBe(0);
      const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls.filter((call) => call.args.some((arg: string) => arg.endsWith("/deployments")))).toHaveLength(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reads later server history pages before allowing publication", () => {
    const directory = mkdtempSync(join(tmpdir(), "server-publication-pagination-"));
    try {
      const bin = fixtureBin(directory);
      const logPath = join(directory, "gh.jsonl");
      const pending = record(headSha, "IN_PROGRESS", { source_sha: headSha, image_digest: liveDigest });
      const result = runWorkflowStep(script, bin, join(directory, "output"), {
        GH_TOKEN: "fixture",
        GH_LOG: logPath,
        GH_HISTORY: history([], true, "page-2"),
        GH_HISTORY_NEXT: history([pending]),
        SOURCE_SHA: parentSha,
        IMAGE_TAG: "sha-old",
        STACK_NAME: "dofek",
        SERVER_HOST: "fixture-host",
        SSH_USER: "ubuntu",
        REPOSITORY: "owner/dofek",
        RUN_ID: "133",
        RUN_ATTEMPT: "1",
        RUN_URL: "https://github.com/owner/dofek/actions/runs/133/attempts/1",
        CANDIDATE_DIGEST: candidateDigest,
        LIVE_SHA: headSha,
        LIVE_DIGEST: liveDigest,
      });
      expect(result.status).not.toBe(0);
      const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls.filter((call) => call.args.includes("graphql"))).toHaveLength(2);
      expect(calls.some((call) => call.args.some((arg: string) => arg.endsWith("/deployments")))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects deployment history whose server ref disagrees with its source payload", () => {
    const directory = mkdtempSync(join(tmpdir(), "server-publication-ref-mismatch-"));
    try {
      const bin = fixtureBin(directory);
      const mismatch = record(parentSha, "SUCCESS", { source_sha: headSha, image_digest: liveDigest });
      const result = runWorkflowStep(script, bin, join(directory, "output"), {
        GH_TOKEN: "fixture",
        GH_LOG: join(directory, "gh.jsonl"),
        GH_HISTORY: history([mismatch]),
        SOURCE_SHA: headSha,
        IMAGE_TAG: "sha-live",
        STACK_NAME: "dofek",
        SERVER_HOST: "fixture-host",
        SSH_USER: "ubuntu",
        REPOSITORY: "owner/dofek",
        RUN_ID: "135",
        RUN_ATTEMPT: "1",
        RUN_URL: "https://github.com/owner/dofek/actions/runs/135/attempts/1",
        CANDIDATE_DIGEST: candidateDigest,
        LIVE_SHA: headSha,
        LIVE_DIGEST: candidateDigest,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("ref does not match");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("supersedes an older server source already behind the live success", () => {
    const directory = mkdtempSync(join(tmpdir(), "server-publication-superseded-"));
    try {
      const bin = fixtureBin(directory);
      const logPath = join(directory, "gh.jsonl");
      const outputPath = join(directory, "output");
      const result = runWorkflowStep(script, bin, outputPath, {
        GH_TOKEN: "fixture",
        GH_LOG: logPath,
        GH_HISTORY: history([
          record(headSha, "SUCCESS", { source_sha: headSha, image_digest: liveDigest }),
        ]),
        SOURCE_SHA: parentSha,
        IMAGE_TAG: "sha-old",
        STACK_NAME: "dofek",
        SERVER_HOST: "fixture-host",
        SSH_USER: "ubuntu",
        REPOSITORY: "owner/dofek",
        RUN_ID: "127",
        RUN_ATTEMPT: "1",
        RUN_URL: "https://github.com/owner/dofek/actions/runs/127/attempts/1",
        CANDIDATE_DIGEST: candidateDigest,
        LIVE_SHA: headSha,
        LIVE_DIGEST: liveDigest,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(outputPath, "utf8")).toContain("decision=superseded");
      const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls.some((call) => call.args.includes("repos/owner/dofek/deployments"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats the same verified server source and digest as a no-op", () => {
    const directory = mkdtempSync(join(tmpdir(), "server-publication-unchanged-"));
    try {
      const bin = fixtureBin(directory);
      const logPath = join(directory, "gh.jsonl");
      const outputPath = join(directory, "output");
      const result = runWorkflowStep(script, bin, outputPath, {
        GH_TOKEN: "fixture",
        GH_LOG: logPath,
        GH_HISTORY: history([record(headSha, "SUCCESS", { source_sha: headSha, image_digest: liveDigest })]),
        SOURCE_SHA: headSha,
        IMAGE_TAG: "sha-live",
        STACK_NAME: "dofek",
        SERVER_HOST: "fixture-host",
        SSH_USER: "ubuntu",
        REPOSITORY: "owner/dofek",
        RUN_ID: "130",
        RUN_ATTEMPT: "1",
        RUN_URL: "https://github.com/owner/dofek/actions/runs/130/attempts/1",
        CANDIDATE_DIGEST: liveDigest,
        LIVE_SHA: headSha,
        LIVE_DIGEST: liveDigest,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(outputPath, "utf8")).toContain("decision=unchanged");
      const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls.some((call) => call.args.includes("repos/owner/dofek/deployments"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps a matching live server intent unresolved until all deploy verification gates can be rerun", () => {
    const directory = mkdtempSync(join(tmpdir(), "server-publication-recovery-"));
    try {
      const bin = fixtureBin(directory);
      const logPath = join(directory, "gh.jsonl");
      const pending = record(headSha, "PENDING", {
        source_sha: headSha,
        image_digest: liveDigest,
        run_url: "https://github.com/owner/dofek/actions/runs/124/attempts/1",
      });
      pending.databaseId = 99;
      const result = runWorkflowStep(script, bin, join(directory, "output"), {
        GH_TOKEN: "fixture",
        GH_LOG: logPath,
        GH_HISTORY: history([pending]),
        SOURCE_SHA: headSha,
        IMAGE_TAG: "sha-live",
        STACK_NAME: "dofek",
        SERVER_HOST: "fixture-host",
        SSH_USER: "ubuntu",
        REPOSITORY: "owner/dofek",
        RUN_ID: "134",
        RUN_ATTEMPT: "2",
        RUN_URL: "https://github.com/owner/dofek/actions/runs/134/attempts/2",
        CANDIDATE_DIGEST: liveDigest,
        LIVE_SHA: headSha,
        LIVE_DIGEST: liveDigest,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unresolved server publication");
      const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls.filter((call) => call.args.some((arg: string) => arg.endsWith("/deployments")))).toHaveLength(0);
      expect(calls.some((call) => call.args.some((arg: string) => arg.endsWith("/statuses")))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a server candidate with no ancestry path to the live target", () => {
    const directory = mkdtempSync(join(tmpdir(), "server-publication-divergent-"));
    const repo = join(directory, "repo");
    mkdirSync(repo);
    const gitIn = (...args: string[]) =>
      String(
        spawnSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).stdout,
      ).trim();
    const commit = (message: string) => {
      writeFileSync(join(repo, "release.txt"), `${message}\n`);
      gitIn("add", "release.txt");
      gitIn("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", message);
      return gitIn("rev-parse", "HEAD");
    };
    try {
      gitIn("init", "--initial-branch=main");
      const liveSha = commit("live");
      gitIn("checkout", "--orphan", "candidate");
      const candidateSha = commit("candidate");
      const bin = fixtureBin(directory);
      const logPath = join(directory, "gh.jsonl");
      const outputPath = join(directory, "output");
      const result = runWorkflowStep(script, bin, outputPath, {
        GIT_DIR: join(repo, ".git"),
        GIT_WORK_TREE: repo,
        GH_TOKEN: "fixture",
        GH_LOG: logPath,
        GH_HISTORY: history([record(liveSha, "SUCCESS", { source_sha: liveSha, image_digest: liveDigest })]),
        SOURCE_SHA: candidateSha,
        IMAGE_TAG: "sha-diverged",
        STACK_NAME: "dofek",
        SERVER_HOST: "fixture-host",
        SSH_USER: "ubuntu",
        REPOSITORY: "owner/dofek",
        RUN_ID: "128",
        RUN_ATTEMPT: "1",
        RUN_URL: "https://github.com/owner/dofek/actions/runs/128/attempts/1",
        CANDIDATE_DIGEST: candidateDigest,
        LIVE_SHA: liveSha,
        LIVE_DIGEST: liveDigest,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unrelated");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("finalizes only after the deploy job has verified the exact live web/worker images", () => {
    const finalize = workflowStep(
      ".github/workflows/deploy-web-environment.yml",
      "finalize-server-receipt",
      "verify-live",
    );
    const directory = mkdtempSync(join(tmpdir(), "server-receipt-finalize-"));
    try {
      const bin = fixtureBin(directory);
      const logPath = join(directory, "gh.jsonl");
      writeFileSync(logPath, "");
      const result = runWorkflowStep(finalize, bin, join(directory, "output"), {
        GH_TOKEN: "fixture",
        GH_LOG: logPath,
        GH_DEPLOYMENT: JSON.stringify({
          id: 99,
          sha: headSha,
          payload: { source_sha: headSha, image_digest: liveDigest },
        }),
        GH_STATUSES: JSON.stringify([{ state: "pending" }]),
        REPOSITORY: "owner/dofek",
        DEPLOYMENT_ID: "99",
        SOURCE_SHA: headSha,
        IMAGE_REF: `ghcr.io/owner/dofek@${liveDigest}`,
        STACK_NAME: "dofek",
        SSH_USER: "ubuntu",
        SERVER_HOST: "fixture-host",
        RUN_URL: "https://github.com/owner/dofek/actions/runs/136/attempts/1",
        RUNNER_TEMP: directory,
        LIVE_SHA: headSha,
        LIVE_DIGEST: liveDigest,
        CANDIDATE_DIGEST: liveDigest,
      });
      expect(result.status, result.stderr).toBe(0);
      const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const success = calls.find((call) => call.args.some((arg: string) => arg.endsWith("/statuses") && call.args.includes("--method")));
      expect(success.args).toContain("repos/owner/dofek/deployments/99/statuses");
      const body = JSON.parse(success.input);
      expect(body).toEqual(expect.objectContaining({ state: "success", auto_inactive: false, description: `Verified server ${headSha}` }));
      expect(body.description.length).toBeLessThanOrEqual(140);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not finalize a server receipt when verified live task source differs", () => {
    const finalize = workflowStep(
      ".github/workflows/deploy-web-environment.yml",
      "finalize-server-receipt",
      "verify-live",
    );
    const directory = mkdtempSync(join(tmpdir(), "server-receipt-mismatch-"));
    try {
      const bin = fixtureBin(directory);
      const logPath = join(directory, "gh.jsonl");
      writeFileSync(logPath, "");
      const result = runWorkflowStep(finalize, bin, join(directory, "output"), {
        GH_TOKEN: "fixture",
        GH_LOG: logPath,
        GH_DEPLOYMENT: JSON.stringify({ id: 99, sha: headSha, payload: { source_sha: headSha, image_digest: liveDigest } }),
        GH_STATUSES: JSON.stringify([{ state: "pending" }]),
        REPOSITORY: "owner/dofek",
        DEPLOYMENT_ID: "99",
        SOURCE_SHA: headSha,
        IMAGE_REF: `ghcr.io/owner/dofek@${liveDigest}`,
        STACK_NAME: "dofek",
        SSH_USER: "ubuntu",
        SERVER_HOST: "fixture-host",
        RUN_URL: "https://github.com/owner/dofek/actions/runs/137/attempts/1",
        RUNNER_TEMP: directory,
        LIVE_SHA: parentSha,
        LIVE_DIGEST: liveDigest,
        CANDIDATE_DIGEST: liveDigest,
      });
      expect(result.status).not.toBe(0);
      const calls = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(calls.some((call) => call.args.some((arg: string) => arg.endsWith("/statuses") && call.args.includes("--method")))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("OTA publication workflow step", () => {
  const script = workflowStep(".github/workflows/deploy-ota.yml", "deploy", "publication");
  const previousRuntime = "2.8.1";

  it("records intent when the live channel has no update", () => {
    const directory = mkdtempSync(join(tmpdir(), "ota-publication-step-"));
    try {
      const bin = fixtureBin(directory);
      const logPath = join(directory, "gh.jsonl");
      const outputPath = join(directory, "output");
      const result = runWorkflowStep(script, bin, outputPath, {
        GH_TOKEN: "fixture",
        GH_LOG: logPath,
        GH_HISTORY: history(),
        RUNNER_TEMP: directory,
        SOURCE_SHA: headSha,
        RUNTIME_VERSION: runtime,
        CURRENT_MANIFEST_ID: "none",
        CURRENT_MANIFEST_RUNTIME: runtime,
        REPOSITORY: "owner/dofek",
        RUN_ID: "125",
        RUN_ATTEMPT: "1",
        RUN_URL: "https://github.com/owner/dofek/actions/runs/125/attempts/1",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(outputPath, "utf8")).toContain("decision=publish");
      const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls).toHaveLength(3);
      expect(JSON.parse(calls[1].input).payload).toEqual(
        expect.objectContaining({ source_sha: headSha, runtime_version: runtime, run_id: "125", run_attempt: "1" }),
      );
      expect(JSON.parse(calls[2].input).state).toBe("pending");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("blocks an older candidate when a newer OTA intent is unresolved", () => {
    const directory = mkdtempSync(join(tmpdir(), "ota-publication-pending-"));
    try {
      const bin = fixtureBin(directory);
      const logPath = join(directory, "gh.jsonl");
      const outputPath = join(directory, "output");
      const pending = {
        databaseId: 42,
        task: "ota-publish",
        commitOid: headSha,
        payload: { source_sha: headSha, runtime_version: runtime, run_id: "124", run_attempt: "1" },
        latestStatus: { state: "PENDING", description: "awaiting publication" },
      };
      const result = runWorkflowStep(script, bin, outputPath, {
        GH_TOKEN: "fixture",
        GH_LOG: logPath,
        GH_HISTORY: history([pending]),
        RUNNER_TEMP: directory,
        SOURCE_SHA: parentSha,
        RUNTIME_VERSION: runtime,
        CURRENT_MANIFEST_ID: updateId,
        CURRENT_MANIFEST_RUNTIME: runtime,
        REPOSITORY: "owner/dofek",
        RUN_ID: "126",
        RUN_ATTEMPT: "1",
        RUN_URL: "https://github.com/owner/dofek/actions/runs/126/attempts/1",
      });
      expect(result.status).not.toBe(0);
      const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls.filter((call) => call.args.some((arg: string) => arg.endsWith("/deployments")))).toHaveLength(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a live OTA update has no source receipt", () => {
    const directory = mkdtempSync(join(tmpdir(), "ota-publication-bootstrap-"));
    try {
      const bin = fixtureBin(directory);
      const logPath = join(directory, "gh.jsonl");
      const result = runWorkflowStep(script, bin, join(directory, "output"), {
        GH_TOKEN: "fixture",
        GH_LOG: logPath,
        GH_HISTORY: history(),
        RUNNER_TEMP: directory,
        SOURCE_SHA: headSha,
        RUNTIME_VERSION: runtime,
        CURRENT_MANIFEST_ID: updateId,
        CURRENT_MANIFEST_RUNTIME: runtime,
        REPOSITORY: "owner/dofek",
        RUN_ID: "131",
        RUN_ATTEMPT: "1",
        RUN_URL: "https://github.com/owner/dofek/actions/runs/131/attempts/1",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Operator initialization required");
      const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls.some((call) => call.args.some((arg: string) => arg.endsWith("/deployments")))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats the same verified OTA UUID and runtime as a no-op", () => {
    const directory = mkdtempSync(join(tmpdir(), "ota-publication-unchanged-"));
    try {
      const bin = fixtureBin(directory);
      const logPath = join(directory, "gh.jsonl");
      const success = {
        databaseId: 44,
        task: "ota-publish",
        commitOid: headSha,
        payload: { source_sha: headSha, runtime_version: runtime, update_id: updateId },
        latestStatus: { state: "SUCCESS", description: `OTA verified ${updateId}` },
      };
      const result = runWorkflowStep(script, bin, join(directory, "output"), {
        GH_TOKEN: "fixture",
        GH_LOG: logPath,
        GH_HISTORY: history([success]),
        RUNNER_TEMP: directory,
        SOURCE_SHA: headSha,
        RUNTIME_VERSION: runtime,
        CURRENT_MANIFEST_ID: updateId,
        CURRENT_MANIFEST_RUNTIME: runtime,
        REPOSITORY: "owner/dofek",
        RUN_ID: "132",
        RUN_ATTEMPT: "1",
        RUN_URL: "https://github.com/owner/dofek/actions/runs/132/attempts/1",
        FIXTURE_UPDATE_ID: updateId,
        FIXTURE_RUNTIME: runtime,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(directory, "output"), "utf8")).toContain("decision=unchanged");
      const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("allows a newer source to publish for a runtime with no update despite another runtime receipt", () => {
    const directory = mkdtempSync(join(tmpdir(), "ota-runtime-first-publish-"));
    try {
      const bin = fixtureBin(directory);
      const prior = {
        databaseId: 45,
        task: "ota-publish",
        commitOid: parentSha,
        payload: { source_sha: parentSha, runtime_version: previousRuntime, update_id: updateId },
        latestStatus: { state: "SUCCESS", description: `OTA verified ${updateId}` },
      };
      const result = runWorkflowStep(script, bin, join(directory, "output"), {
        GH_TOKEN: "fixture",
        GH_LOG: join(directory, "gh.jsonl"),
        GH_HISTORY: history([prior]),
        RUNNER_TEMP: directory,
        SOURCE_SHA: headSha,
        RUNTIME_VERSION: runtime,
        CURRENT_MANIFEST_ID: "none",
        CURRENT_MANIFEST_RUNTIME: runtime,
        REPOSITORY: "owner/dofek",
        RUN_ID: "138",
        RUN_ATTEMPT: "1",
        RUN_URL: "https://github.com/owner/dofek/actions/runs/138/attempts/1",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(directory, "output"), "utf8")).toContain("decision=publish");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("no-ops a previously verified runtime even when another runtime has a newer global receipt", () => {
    const directory = mkdtempSync(join(tmpdir(), "ota-runtime-revisit-"));
    try {
      const bin = fixtureBin(directory);
      const newerRuntime = {
        databaseId: 46,
        task: "ota-publish",
        commitOid: headSha,
        payload: { source_sha: headSha, runtime_version: runtime, update_id: "11111111-1111-1111-1111-111111111111" },
        latestStatus: { state: "SUCCESS", description: "OTA verified 11111111-1111-1111-1111-111111111111" },
      };
      const requestedRuntime = {
        databaseId: 47,
        task: "ota-publish",
        commitOid: parentSha,
        payload: { source_sha: parentSha, runtime_version: previousRuntime, update_id: updateId },
        latestStatus: { state: "SUCCESS", description: `OTA verified ${updateId}` },
      };
      const result = runWorkflowStep(script, bin, join(directory, "output"), {
        GH_TOKEN: "fixture",
        GH_LOG: join(directory, "gh.jsonl"),
        GH_HISTORY: history([newerRuntime, requestedRuntime]),
        RUNNER_TEMP: directory,
        SOURCE_SHA: parentSha,
        RUNTIME_VERSION: previousRuntime,
        CURRENT_MANIFEST_ID: updateId,
        CURRENT_MANIFEST_RUNTIME: previousRuntime,
        FIXTURE_UPDATE_ID: updateId,
        FIXTURE_RUNTIME: previousRuntime,
        REPOSITORY: "owner/dofek",
        RUN_ID: "139",
        RUN_ATTEMPT: "1",
        RUN_URL: "https://github.com/owner/dofek/actions/runs/139/attempts/1",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(directory, "output"), "utf8")).toContain("decision=unchanged");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an OTA deployment whose Git ref disagrees with its source payload", () => {
    const directory = mkdtempSync(join(tmpdir(), "ota-runtime-ref-mismatch-"));
    try {
      const bin = fixtureBin(directory);
      const mismatch = {
        databaseId: 48,
        task: "ota-publish",
        commitOid: parentSha,
        payload: { source_sha: headSha, runtime_version: runtime, update_id: updateId },
        latestStatus: { state: "SUCCESS", description: `OTA verified ${updateId}` },
      };
      const result = runWorkflowStep(script, bin, join(directory, "output"), {
        GH_TOKEN: "fixture",
        GH_LOG: join(directory, "gh.jsonl"),
        GH_HISTORY: history([mismatch]),
        RUNNER_TEMP: directory,
        SOURCE_SHA: headSha,
        RUNTIME_VERSION: runtime,
        CURRENT_MANIFEST_ID: updateId,
        CURRENT_MANIFEST_RUNTIME: runtime,
        REPOSITORY: "owner/dofek",
        RUN_ID: "140",
        RUN_ATTEMPT: "1",
        RUN_URL: "https://github.com/owner/dofek/actions/runs/140/attempts/1",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("ref does not match");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers the same OTA intent only after the live update verifier confirms its UUID and runtime", () => {
    const directory = mkdtempSync(join(tmpdir(), "ota-publication-recovery-"));
    try {
      const bin = fixtureBin(directory);
      const logPath = join(directory, "gh.jsonl");
      const outputPath = join(directory, "output");
      const pending = {
        databaseId: 43,
        task: "ota-publish",
        commitOid: headSha,
        payload: { source_sha: headSha, runtime_version: runtime, run_id: "124", run_attempt: "1" },
        latestStatus: { state: "IN_PROGRESS", description: "awaiting receipt" },
      };
      const result = runWorkflowStep(script, bin, outputPath, {
        GH_TOKEN: "fixture",
        GH_LOG: logPath,
        GH_HISTORY: history([pending]),
        SOURCE_SHA: headSha,
        RUNTIME_VERSION: runtime,
        CURRENT_MANIFEST_ID: updateId,
        CURRENT_MANIFEST_RUNTIME: runtime,
        REPOSITORY: "owner/dofek",
        RUN_ID: "129",
        RUN_ATTEMPT: "2",
        RUN_URL: "https://github.com/owner/dofek/actions/runs/129/attempts/2",
        RUNNER_TEMP: directory,
        FIXTURE_UPDATE_ID: updateId,
        FIXTURE_RUNTIME: runtime,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(outputPath, "utf8")).toContain(`decision=recover\ndeployment_id=43\nupdate_id=${updateId}`);
      const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls).toHaveLength(1);
      expect(readFileSync(join(directory, "dofek-ota-preflight", "xprem-update-metadata.json"), "utf8")).toContain(updateId);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
