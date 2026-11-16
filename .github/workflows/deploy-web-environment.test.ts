import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  candidateDigest,
  fixtureBin,
  graphqlStringPayload,
  headSha,
  history,
  liveDigest,
  parentSha,
  record,
  runWorkflowStep,
  workflowStep,
} from "./deploy-publication.test-helpers.ts";

describe("server publication workflow step", () => {
  const script = workflowStep(".github/workflows/deploy-web-environment.yml", "check", "publication");

  it("does not invent a successful baseline from matching live tasks without a verified receipt", () => {
    const directory = mkdtempSync(join(tmpdir(), "server-unverified-bootstrap-"));
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
        IMAGE_TAG: "sha-test",
        STACK_NAME: "dofek",
        SERVER_HOST: "fixture-host",
        SSH_USER: "ubuntu",
        REPOSITORY: "owner/dofek",
        RUN_ID: "123",
        RUN_ATTEMPT: "1",
        RUN_URL: "https://github.com/owner/dofek/actions/runs/123/attempts/1",
        CANDIDATE_DIGEST: candidateDigest,
        LIVE_SHA: headSha,
        LIVE_DIGEST: candidateDigest,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Operator initialization required");
      expect(existsSync(outputPath)).toBe(false);
      const calls = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(calls.some((call) => call.args.some((arg: string) => arg.endsWith("/statuses")))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reconciles a live server identity and records a durable intent before Terraform", () => {
    const directory = mkdtempSync(join(tmpdir(), "server-publication-step-"));
    try {
      const bin = fixtureBin(directory);
      const outputPath = join(directory, "output");
      const logPath = join(directory, "gh.jsonl");
      const result = runWorkflowStep(script, bin, outputPath, {
        GH_TOKEN: "fixture",
        GH_LOG: logPath,
        GH_HISTORY: history([
          record(
            parentSha,
            "SUCCESS",
            graphqlStringPayload({ source_sha: parentSha, image_digest: liveDigest }),
          ),
        ]),
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
        ENVIRONMENT_URL: "https://dofek.fit",
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
      expect(statuses).toHaveLength(1);
      expect(JSON.parse(statuses[0].input).state).toBe("pending");
      expect(JSON.parse(statuses[0].input)).toEqual(
        expect.objectContaining({
          log_url: "https://github.com/owner/dofek/actions/runs/123/attempts/1",
          environment_url: "https://dofek.fit",
        }),
      );
      const historyQuery = calls.find((call) => call.args.includes("graphql"));
      expect(JSON.parse(historyQuery.input).variables.environment).toBe("server-production");
      const creation = calls.find((call) => call.args.includes("repos/owner/dofek/deployments"));
      expect(JSON.parse(creation.input).environment).toBe("server-production");
      expect(JSON.parse(creation.input).production_environment).toBe(true);
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
      const mismatch = record(
        parentSha,
        "SUCCESS",
        graphqlStringPayload({ source_sha: headSha, image_digest: liveDigest }),
      );
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

  it("rejects deployment history whose encoded digest disagrees with the live immutable image", () => {
    const directory = mkdtempSync(join(tmpdir(), "server-publication-digest-mismatch-"));
    try {
      const bin = fixtureBin(directory);
      const logPath = join(directory, "gh.jsonl");
      const result = runWorkflowStep(script, bin, join(directory, "output"), {
        GH_TOKEN: "fixture",
        GH_LOG: logPath,
        GH_HISTORY: history([
          record(
            parentSha,
            "SUCCESS",
            graphqlStringPayload({ source_sha: parentSha, image_digest: candidateDigest }),
          ),
        ]),
        SOURCE_SHA: headSha,
        IMAGE_TAG: "sha-test",
        STACK_NAME: "dofek",
        SERVER_HOST: "fixture-host",
        SSH_USER: "ubuntu",
        REPOSITORY: "owner/dofek",
        RUN_ID: "141",
        RUN_ATTEMPT: "1",
        RUN_URL: "https://github.com/owner/dofek/actions/runs/141/attempts/1",
        CANDIDATE_DIGEST: candidateDigest,
        LIVE_SHA: parentSha,
        LIVE_DIGEST: liveDigest,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("live server identity does not match");
      const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls.filter((call) => call.args.includes("--method"))).toHaveLength(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["empty string", ""],
    ["malformed JSON", "{"],
    [
      "triple-encoded JSON",
      JSON.stringify(JSON.stringify(JSON.stringify({ source_sha: parentSha, image_digest: liveDigest }))),
    ],
    ["non-object JSON", JSON.stringify(JSON.stringify([parentSha, liveDigest]))],
  ])("fails closed for %s history payload before posting a server deployment", (_label, payload) => {
    const directory = mkdtempSync(join(tmpdir(), "server-publication-invalid-payload-"));
    try {
      const bin = fixtureBin(directory);
      const logPath = join(directory, "gh.jsonl");
      const result = runWorkflowStep(script, bin, join(directory, "output"), {
        GH_TOKEN: "fixture",
        GH_LOG: logPath,
        GH_HISTORY: history([record(parentSha, "SUCCESS", payload)]),
        SOURCE_SHA: headSha,
        IMAGE_TAG: "sha-test",
        STACK_NAME: "dofek",
        SERVER_HOST: "fixture-host",
        SSH_USER: "ubuntu",
        REPOSITORY: "owner/dofek",
        RUN_ID: "142",
        RUN_ATTEMPT: "1",
        RUN_URL: "https://github.com/owner/dofek/actions/runs/142/attempts/1",
        CANDIDATE_DIGEST: candidateDigest,
        LIVE_SHA: parentSha,
        LIVE_DIGEST: liveDigest,
      });
      expect(result.status).not.toBe(0);
      const calls = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(calls.filter((call) => call.args.includes("--method"))).toHaveLength(0);
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
        GH_HISTORY: history([
          record(
            headSha,
            "SUCCESS",
            JSON.stringify({ source_sha: headSha, image_digest: liveDigest }),
          ),
        ]),
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
      execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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
          environment: "server-production",
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
        ENVIRONMENT_URL: "https://dofek.fit",
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
      expect(body).toEqual(
        expect.objectContaining({
          state: "success",
          auto_inactive: false,
          log_url: "https://github.com/owner/dofek/actions/runs/136/attempts/1",
          environment_url: "https://dofek.fit",
          description: `Verified server ${headSha}`,
        }),
      );
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
        GH_DEPLOYMENT: JSON.stringify({ id: 99, sha: headSha, environment: "server-production", payload: { source_sha: headSha, image_digest: liveDigest } }),
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
