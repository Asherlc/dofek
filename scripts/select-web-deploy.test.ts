import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const newestCommit = "b".repeat(40);
const triggeringCommit = "a".repeat(40);

function selectDeploy({
  eventName = "workflow_run",
  conclusion = "success",
  imageTag = "sha-abc1234",
  latestRun = { id: 1234, head_sha: newestCommit },
  apiExitStatus = 0,
}: {
  eventName?: string;
  conclusion?: string;
  imageTag?: string;
  latestRun?: { id: number; head_sha: string } | null;
  apiExitStatus?: number;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "select-web-deploy-"));
  const binaryDirectory = join(directory, "bin");
  mkdirSync(binaryDirectory);
  const eventPath = join(directory, "event.json");
  const outputPath = join(directory, "output");
  const summaryPath = join(directory, "summary");
  const invocationPath = join(directory, "gh-calls.jsonl");
  const responsePath = join(directory, "response.json");
  writeFileSync(
    eventPath,
    JSON.stringify({
      inputs: { image_tag: imageTag },
      workflow_run: { conclusion, head_sha: triggeringCommit },
    }),
  );
  writeFileSync(responsePath, JSON.stringify(latestRun));
  writeFileSync(outputPath, "");
  writeFileSync(summaryPath, "");
  writeFileSync(invocationPath, "");
  const ghPath = join(binaryDirectory, "gh");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
appendFileSync(process.env.DEPLOY_TEST_INVOCATIONS, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.DEPLOY_TEST_API_STATUS !== "0") {
  console.error("GitHub API request failed");
  process.exit(Number(process.env.DEPLOY_TEST_API_STATUS));
}
if (!process.argv.includes("POST")) {
  process.stdout.write(readFileSync(process.env.DEPLOY_TEST_RESPONSE));
}
`,
  );
  chmodSync(ghPath, 0o755);

  try {
    const result = spawnSync(
      resolve("node_modules/.bin/tsx"),
      [resolve("scripts/select-web-deploy.ts")],
      {
        env: {
          ...process.env,
          PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
          GITHUB_EVENT_NAME: eventName,
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: outputPath,
          GITHUB_STEP_SUMMARY: summaryPath,
          GITHUB_REPOSITORY: "owner/dofek",
          GITHUB_RUN_ID: "900",
          DEPLOY_TEST_INVOCATIONS: invocationPath,
          DEPLOY_TEST_RESPONSE: responsePath,
          DEPLOY_TEST_API_STATUS: String(apiExitStatus),
        },
        encoding: "utf8",
      },
    );
    return {
      status: result.status,
      stderr: result.stderr,
      output: readFileSync(outputPath, "utf8"),
      summary: readFileSync(summaryPath, "utf8"),
      invocations: readFileSync(invocationPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("select-web-deploy", () => {
  it("selects the newest successful main push after waiting, even when a different commit triggered the request", () => {
    const result = selectDeploy();

    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe(
      `image_tag=sha-bbbbbbb\ncommit_sha=${newestCommit}\nci_run_id=1234\n`,
    );
    expect(result.summary).toContain(newestCommit);
    expect(result.summary).toContain("https://github.com/owner/dofek/actions/runs/1234");
    expect(result.invocations).toEqual([
      [
        "api",
        "--method",
        "GET",
        "repos/owner/dofek/actions/workflows/ci.yml/runs",
        "-f",
        "branch=main",
        "-f",
        "event=push",
        "-f",
        "status=success",
        "-F",
        "per_page=1",
        "--jq",
        ".workflow_runs[0] | if . == null then null else {id, head_sha} end",
      ],
    ]);
  });

  it.each(["failure", "cancelled", "skipped", "timed_out"])(
    "cancels a request blocked by %s CI without reporting success",
    (conclusion) => {
      const result = selectDeploy({ conclusion });

      expect(result.status).not.toBe(0);
      expect(result.output).toBe("");
      expect(result.summary).toContain(conclusion);
      expect(result.invocations).toEqual([
        ["api", "--method", "POST", "repos/owner/dofek/actions/runs/900/cancel"],
      ]);
    },
  );

  it("preserves a manual image request without selecting another commit", () => {
    const result = selectDeploy({ eventName: "workflow_dispatch", imageTag: "sha-abc1234" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe("image_tag=sha-abc1234\ncommit_sha=\nci_run_id=\n");
    expect(result.invocations).toEqual([]);
  });

  it("fails explicitly when no successful main CI release exists", () => {
    const result = selectDeploy({ latestRun: null });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("No successful main CI run");
    expect(result.output).toBe("");
  });

  it("fails when GitHub cannot resolve the latest release", () => {
    const result = selectDeploy({ apiExitStatus: 1 });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("GitHub API request failed");
    expect(result.output).toBe("");
  });

  it("fails when the cancellation request cannot be accepted", () => {
    const result = selectDeploy({ conclusion: "cancelled", apiExitStatus: 1 });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("GitHub API request failed");
    expect(result.output).toBe("");
  });

  it("rejects a manual image tag containing an output-file injection", () => {
    const result = selectDeploy({
      eventName: "workflow_dispatch",
      imageTag: "latest\ncommit_sha=malicious",
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toBe("");
  });
});
