import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

function handoffScript(): string {
  const workflow = z
    .object({
      jobs: z.object({
        automatic: z.object({ steps: z.array(z.object({ run: z.string() })) }),
      }),
    })
    .parse(parse(readFileSync(".github/workflows/deploy-web.yml", "utf8")));
  return workflow.jobs.automatic.steps.map((step) => step.run).join("\n");
}

const releaseSha = "c35c32bedba7096395d568e6c09cc86fd02f79b0";
const releaseTag = `deploy-${releaseSha}`;

function runHandoff({
  dispatchStatus = 0,
  watchStatus = 0,
  runId = "12345",
  tagSha = "",
  lookupStatus = 0,
  createStatus = 0,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "deploy-handoff-"));
  const callsPath = join(directory, "calls.jsonl");
  const summaryPath = join(directory, "summary");
  try {
    writeFileSync(callsPath, "");
    writeFileSync(summaryPath, "");
    writeFileSync(
      join(directory, "gh"),
      `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "api") {
  if (args.some(arg => arg.includes("/git/matching-refs/"))) {
    process.exitCode = Number(process.env.TEST_LOOKUP_STATUS);
    console.log(process.env.TEST_TAG_SHA);
  } else if (args.includes("repos/owner/dofek/git/refs")) {
    process.exitCode = Number(process.env.TEST_CREATE_STATUS);
    console.log(process.env.COMMIT_SHA);
  } else {
    process.exitCode = Number(process.env.TEST_DISPATCH_STATUS);
    console.log(process.env.TEST_RUN_ID);
  }
} else if (args[0] === "run" && args[1] === "watch") {
  process.exit(Number(process.env.TEST_WATCH_STATUS));
} else process.exit(99);
`,
    );
    chmodSync(join(directory, "gh"), 0o755);
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", handoffScript()], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        GITHUB_REPOSITORY: "owner/dofek",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_STEP_SUMMARY: summaryPath,
        COMMIT_SHA: releaseSha,
        IMAGE_TAG: "sha-c35c32b",
        TEST_CALLS: callsPath,
        TEST_RUN_ID: runId,
        TEST_DISPATCH_STATUS: String(dispatchStatus),
        TEST_WATCH_STATUS: String(watchStatus),
        TEST_TAG_SHA: tagSha,
        TEST_LOOKUP_STATUS: String(lookupStatus),
        TEST_CREATE_STATUS: String(createStatus),
      },
    });
    return {
      ...result,
      calls: readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
      summary: readFileSync(summaryPath, "utf8"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("automatic production handoff", () => {
  it("creates the selected commit's release tag, dispatches its workflow, and watches that exact run", () => {
    const result = runHandoff();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual([
      [
        "api",
        `repos/owner/dofek/git/matching-refs/tags/${releaseTag}`,
        "--jq",
        `.[] | select(.ref == "refs/tags/${releaseTag}") | .object.sha`,
      ],
      [
        "api",
        "--method",
        "POST",
        "repos/owner/dofek/git/refs",
        "-f",
        `ref=refs/tags/${releaseTag}`,
        "-f",
        `sha=${releaseSha}`,
        "--jq",
        ".object.sha",
      ],
      [
        "api",
        "--method",
        "POST",
        "repos/owner/dofek/actions/workflows/deploy.yml/dispatches",
        "-f",
        `ref=${releaseTag}`,
        "-f",
        "inputs[target]=all",
        "-f",
        "inputs[image_tag]=sha-c35c32b",
        "-F",
        "return_run_details=true",
        "--jq",
        ".workflow_run_id",
      ],
      ["run", "watch", "12345", "--repo", "owner/dofek", "--exit-status"],
    ]);
    expect(result.summary).toContain("https://github.com/owner/dofek/actions/runs/12345");
  });

  it("reuses an existing tag pointing to the selected release", () => {
    const result = runHandoff({ tagSha: releaseSha });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toHaveLength(3);
    expect(result.calls[1]).toContain(`ref=${releaseTag}`);
  });

  it("rejects an existing release tag pointing at another commit before dispatch", () => {
    const result = runHandoff({ tagSha: "a".repeat(40) });
    expect(result.status).not.toBe(0);
    expect(result.calls).toHaveLength(1);
    expect(result.stdout).toContain("does not point to selected commit");
  });

  it("fails when release tags cannot be read", () => {
    const result = runHandoff({ lookupStatus: 40 });
    expect(result.status).toBe(40);
    expect(result.calls).toHaveLength(1);
  });

  it("fails when the release tag cannot be created", () => {
    const result = runHandoff({ createStatus: 41 });
    expect(result.status).toBe(41);
    expect(result.calls).toHaveLength(2);
  });

  it("fails when the selected release cannot be dispatched", () => {
    const result = runHandoff({ dispatchStatus: 42 });
    expect(result.status).toBe(42);
    expect(result.calls).toHaveLength(3);
  });

  it("propagates a failed child deployment", () => {
    const result = runHandoff({ watchStatus: 43 });
    expect(result.status).toBe(43);
    expect(result.calls).toHaveLength(4);
  });

  it.each(["", "null", "unexpected", "0"])(
    "fails before watching a missing or invalid run identity: %s",
    (runId) => {
      const result = runHandoff({ runId });
      expect(result.status).not.toBe(0);
      expect(result.calls).toHaveLength(3);
      expect(result.stdout).toContain("did not return a valid run ID");
    },
  );
});
