import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

type CommitPosition = "older" | "triggering" | "previous" | "side" | "newest";

interface SuccessfulRun {
  id: number;
  head_sha: string;
  head_branch: string;
  event: string;
  conclusion: string;
}

function selectDeploy({
  eventName = "workflow_run",
  conclusion = "success",
  imageTag = "sha-abc1234",
  successfulRuns = { newest: 1234, triggering: 1000 },
  runOverrides = {},
  requestedCommit,
  apiExitStatus = 0,
}: {
  eventName?: string;
  conclusion?: string | null;
  imageTag?: string;
  successfulRuns?: Partial<Record<CommitPosition, number>>;
  runOverrides?: Partial<SuccessfulRun>;
  requestedCommit?: string;
  apiExitStatus?: number;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "select-web-deploy-"));
  execFileSync("git", ["init", "--initial-branch=main", directory], { stdio: "ignore" });
  const tree = execFileSync("git", ["mktree"], {
    cwd: directory,
    input: "",
    encoding: "utf8",
  }).trim();
  function commit(position: CommitPosition, parents: string[] = []): string {
    const ordinal = ["older", "triggering", "previous", "side", "newest"].indexOf(position) + 1;
    const date = `2030-01-0${ordinal}T00:00:00Z`;
    return execFileSync(
      "git",
      [
        "-c",
        "user.name=Deploy Test",
        "-c",
        "user.email=deploy@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit-tree",
        tree,
        ...parents.flatMap((parent) => ["-p", parent]),
        "-m",
        position,
      ],
      {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      },
    ).trim();
  }
  const older = commit("older");
  const triggering = commit("triggering", [older]);
  const previous = commit("previous", [triggering]);
  const side = commit("side", [triggering]);
  const commits = {
    older,
    triggering,
    previous,
    side,
    newest: commit("newest", [previous, side]),
  };
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", commits.newest], {
    cwd: directory,
  });
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
      workflow_run: { conclusion, head_sha: requestedCommit ?? commits.triggering },
    }),
  );
  const responses: Record<string, SuccessfulRun> = {};
  for (const position of ["older", "triggering", "previous", "side", "newest"] as const) {
    const id = successfulRuns[position];
    if (id !== undefined) {
      responses[commits[position]] = {
        id,
        head_sha: commits[position],
        head_branch: "main",
        event: "push",
        conclusion: "success",
        ...runOverrides,
      };
    }
  }
  writeFileSync(
    responsePath,
    JSON.stringify({
      byCommit: responses,
      staleRun: {
        id: 700,
        head_sha: commits.older,
        head_branch: "main",
        event: "push",
        conclusion: "success",
      },
    }),
  );
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
  const response = JSON.parse(readFileSync(process.env.DEPLOY_TEST_RESPONSE, "utf8"));
  const commitFilter = process.argv.find(argument => argument.startsWith("head_sha="));
  process.stdout.write(JSON.stringify(commitFilter
    ? response.byCommit[commitFilter.slice("head_sha=".length)] ?? null
    : response.staleRun));
}
`,
  );
  chmodSync(ghPath, 0o755);

  try {
    const result = spawnSync(
      resolve("node_modules/.bin/tsx"),
      [resolve("scripts/select-web-deploy.ts")],
      {
        cwd: directory,
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
      commits,
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
  it("selects the newest passing main commit when the broad CI lookup returns a stale release", () => {
    const result = selectDeploy();

    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe(
      `image_tag=sha-${result.commits.newest.slice(0, 7)}\ncommit_sha=${result.commits.newest}\nci_run_id=1234\n`,
    );
    expect(result.summary).toContain(result.commits.newest);
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
        "-f",
        `head_sha=${result.commits.newest}`,
        "-F",
        "per_page=1",
        "--jq",
        ".workflow_runs[0] | if . == null then null else {id, head_sha, head_branch, event, conclusion} end",
      ],
    ]);
  });

  it("skips a newer unvalidated main commit and selects the next passing commit", () => {
    const result = selectDeploy({ successfulRuns: { previous: 1200, triggering: 1000 } });

    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe(
      `image_tag=sha-${result.commits.previous.slice(0, 7)}\ncommit_sha=${result.commits.previous}\nci_run_id=1200\n`,
    );
    expect(result.invocations).toHaveLength(2);
  });

  it("ignores a passing second-parent commit when selecting from merged main history", () => {
    const result = selectDeploy({
      successfulRuns: { side: 1300, previous: 1200, triggering: 1000 },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain(`commit_sha=${result.commits.previous}\n`);
    expect(
      result.invocations.map((invocation) =>
        invocation.find((argument: string) => argument.startsWith("head_sha=")),
      ),
    ).toEqual([`head_sha=${result.commits.newest}`, `head_sha=${result.commits.previous}`]);
  });

  it("selects the triggering commit when newer main commits have no successful CI", () => {
    const result = selectDeploy({ successfulRuns: { triggering: 1000 } });

    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe(
      `image_tag=sha-${result.commits.triggering.slice(0, 7)}\ncommit_sha=${result.commits.triggering}\nci_run_id=1000\n`,
    );
    expect(result.invocations).toHaveLength(3);
  });

  it("rejects a CI lookup that returns a different commit", () => {
    const result = selectDeploy({ runOverrides: { head_sha: "d".repeat(40) } });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("returned a different commit");
    expect(result.output).toBe("");
  });

  it.each([
    { head_branch: "feature" },
    { event: "pull_request" },
    { conclusion: "failure" },
    { id: 0 },
  ])("rejects an ineligible CI response: %j", (runOverrides) => {
    const result = selectDeploy({ runOverrides });

    expect(result.status).not.toBe(0);
    expect(result.output).toBe("");
  });

  it("fails when the triggering commit is absent from checked-out main history", () => {
    const result = selectDeploy({ requestedCommit: "e".repeat(40) });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("is not in the checked-out main history");
    expect(result.output).toBe("");
    expect(result.invocations).toEqual([]);
  });

  it.each(["failure", "cancelled", "skipped", "timed_out", null])(
    "cancels a request blocked by %s CI without reporting success",
    (conclusion) => {
      const result = selectDeploy({ conclusion });

      expect(result.status).not.toBe(0);
      expect(result.output).toBe("");
      expect(result.summary).toContain(conclusion ?? "unknown");
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

  it("fails instead of deploying an older release when CI cannot verify the eligible commits", () => {
    const result = selectDeploy({ successfulRuns: { older: 500 } });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("No successful main CI run");
    expect(result.output).toBe("");
    expect(result.invocations).toHaveLength(3);
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
