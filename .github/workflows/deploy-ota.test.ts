import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fixtureBin,
  graphqlStringPayload,
  headSha,
  history,
  parentSha,
  readWorkflow,
  runWorkflowStep,
  runtime,
  updateId,
  workflowStep,
} from "./deploy-publication.test-helpers.ts";

const workflowPath = ".github/workflows/deploy-ota.yml";
const mobileRequire = createRequire(join(process.cwd(), "packages/mobile/package.json"));
const eoasPackagePath = dirname(mobileRequire.resolve("eoas/package.json"));
const eoasRequire = createRequire(join(eoasPackagePath, "package.json"));
const { ensureRepoIsCleanAsync } = eoasRequire(
  join(eoasPackagePath, "dist/lib/repo.js"),
) as {
  ensureRepoIsCleanAsync(
    client: { isCommitRequiredAsync(): Promise<boolean>; showChangedFilesAsync(): Promise<void> },
    nonInteractive: boolean,
  ): Promise<void>;
};
const { default: EoasGitClient } = eoasRequire(
  join(eoasPackagePath, "dist/lib/vcs/clients/git.js"),
) as {
  default: new (repositoryRoot: string) => {
    isCommitRequiredAsync(): Promise<boolean>;
    showChangedFilesAsync(): Promise<void>;
  };
};

function git(directory: string, ...arguments_: string[]) {
  return execFileSync("git", arguments_, { cwd: directory, encoding: "utf8" }).trim();
}

function createHistoricalCandidate() {
  const directory = mkdtempSync(join(tmpdir(), "ota-release-checkout-"));
  git(directory, "init", "-q");
  git(directory, "config", "user.email", "ota-test@example.invalid");
  git(directory, "config", "user.name", "OTA regression test");
  mkdirSync(join(directory, "packages/mobile"), { recursive: true });
  writeFileSync(join(directory, "packages/mobile/app.json"), '{"expo":{"name":"candidate"}}\n');
  git(directory, "add", "packages/mobile/app.json");
  git(directory, "commit", "-qm", "historical candidate without current gitignore");
  const trustedCheckout = join(directory, ".release-tools");
  git(directory, "init", "-q", trustedCheckout);
  git(trustedCheckout, "config", "user.email", "ota-controls@example.invalid");
  git(trustedCheckout, "config", "user.name", "Trusted OTA controls");
  mkdirSync(join(trustedCheckout, ".github/actions"), { recursive: true });
  writeFileSync(join(trustedCheckout, ".github/actions/control.yml"), "trusted current controls\n");
  git(trustedCheckout, "add", ".github/actions/control.yml");
  git(trustedCheckout, "commit", "-qm", "trusted current OTA controls");
  return directory;
}

function auxiliaryCheckoutStatusStep() {
  const step = readWorkflow(workflowPath).jobs.deploy?.steps?.find(
    (candidate) => candidate.name === "Exclude trusted OTA controls from candidate status",
  );
  if (!step?.run) throw new Error("trusted OTA checkout status step is missing");
  return step.run;
}

function runAuxiliaryCheckoutStatusStep(directory: string) {
  return spawnSync("bash", ["-euo", "pipefail", "-c", auxiliaryCheckoutStatusStep()], {
    cwd: directory,
    encoding: "utf8",
  });
}

describe("OTA publication trusted checkout", () => {
  it("ignores only the auxiliary checkout in an old candidate without a gitignore", async () => {
    const directory = createHistoricalCandidate();
    try {
      expect(existsSync(join(directory, ".gitignore"))).toBe(false);
      expect(git(directory, "status", "--porcelain=v1", "--untracked-files=all")).toContain(
        ".release-tools/",
      );
      const trackedBefore = git(directory, "ls-files", "--stage");
      const sourceBefore = readFileSync(join(directory, "packages/mobile/app.json"), "utf8");

      const result = runAuxiliaryCheckoutStatusStep(directory);
      expect(result.status, result.stderr).toBe(0);
      expect(git(directory, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
      expect(git(directory, "check-ignore", "-v", ".release-tools/.github/actions/control.yml")).toContain(
        "/.release-tools/",
      );
      expect(git(directory, "ls-files", "--stage")).toBe(trackedBefore);
      expect(readFileSync(join(directory, "packages/mobile/app.json"), "utf8")).toBe(sourceBefore);
      await expect(ensureRepoIsCleanAsync(new EoasGitClient(directory), true)).resolves.toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["tracked candidate edits", "packages/mobile/app.json", '{"expo":{"name":"modified"}}\n'],
    ["untracked candidate app files", "packages/mobile/new-app-file.ts", "export {};\n"],
  ])("keeps %s dirty for the publisher guard", async (_name, path, contents) => {
    const directory = createHistoricalCandidate();
    try {
      const result = runAuxiliaryCheckoutStatusStep(directory);
      expect(result.status, result.stderr).toBe(0);
      writeFileSync(join(directory, path), contents);

      const status = git(directory, "status", "--porcelain=v1", "--untracked-files=all");
      expect(status).toContain(path);
      expect(status).not.toContain(".release-tools/");
      await expect(ensureRepoIsCleanAsync(new EoasGitClient(directory), true)).rejects.toThrow(
        "Commit all changes. Aborting...",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
describe("OTA publication workflow step", () => {
  const script = workflowStep(".github/workflows/deploy-ota.yml", "deploy", "publication");
  const previousRuntime = "2.8.1";

  it("fails closed when the live manifest probe outputs are absent", () => {
    const directory = mkdtempSync(join(tmpdir(), "ota-missing-live-probe-"));
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
        REPOSITORY: "owner/dofek",
        RUN_ID: "125",
        RUN_ATTEMPT: "1",
        RUN_URL: "https://github.com/owner/dofek/actions/runs/125/attempts/1",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("live OTA manifest probe outputs are missing");
      const calls = existsSync(logPath)
        ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [];
      expect(calls.some((call) => call.args.some((arg: string) => arg.endsWith("/deployments")))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
      const deployment = JSON.parse(calls[1].input);
      expect(deployment.payload).toEqual(
        expect.objectContaining({ source_sha: headSha, runtime_version: runtime, run_id: "125", run_attempt: "1" }),
      );
      expect(deployment.environment).toBe("ota-production");
      expect(deployment.production_environment).toBe(true);
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
        GH_HISTORY: history([
          {
            ...success,
            payload: graphqlStringPayload(success.payload),
          },
        ]),
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
        payload: JSON.stringify({ source_sha: parentSha, runtime_version: previousRuntime, update_id: updateId }),
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
        GH_HISTORY: history([
          {
            ...mismatch,
            payload: graphqlStringPayload(mismatch.payload),
          },
        ]),
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

  it.each([
    ["empty string", ""],
    ["malformed JSON", "{"],
    [
      "triple-encoded JSON",
      JSON.stringify(JSON.stringify(JSON.stringify({ source_sha: headSha, runtime_version: runtime, update_id: updateId }))),
    ],
    ["non-object JSON", JSON.stringify(JSON.stringify([headSha, runtime, updateId]))],
  ])("fails closed for %s history payload before posting an OTA deployment", (_label, payload) => {
    const directory = mkdtempSync(join(tmpdir(), "ota-publication-invalid-payload-"));
    try {
      const bin = fixtureBin(directory);
      const logPath = join(directory, "gh.jsonl");
      const result = runWorkflowStep(script, bin, join(directory, "output"), {
        GH_TOKEN: "fixture",
        GH_LOG: logPath,
        GH_HISTORY: history([
          {
            databaseId: 49,
            task: "ota-publish",
            commitOid: headSha,
            payload,
            latestStatus: { state: "SUCCESS", description: `OTA verified ${updateId}` },
          },
        ]),
        RUNNER_TEMP: directory,
        SOURCE_SHA: headSha,
        RUNTIME_VERSION: runtime,
        CURRENT_MANIFEST_ID: updateId,
        CURRENT_MANIFEST_RUNTIME: runtime,
        REPOSITORY: "owner/dofek",
        RUN_ID: "143",
        RUN_ATTEMPT: "1",
        RUN_URL: "https://github.com/owner/dofek/actions/runs/143/attempts/1",
      });
      expect(result.status).not.toBe(0);
      const calls = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(calls.filter((call) => call.args.includes("--method"))).toHaveLength(0);
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
        payload: graphqlStringPayload({ source_sha: headSha, runtime_version: runtime, run_id: "124", run_attempt: "1" }),
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
