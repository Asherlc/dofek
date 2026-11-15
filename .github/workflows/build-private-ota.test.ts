import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const action = parse(readFileSync(".github/actions/build-private-ota/action.yml", "utf8")) as {
  runs: { steps: Array<{ id?: string; run?: string }> };
};

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

describe("private OTA image source", () => {
  it("requires the checkout to match the selected full source SHA before building", () => {
    const directory = mkdtempSync(join(tmpdir(), "dofek-ota-source-"));
    temporaryDirectories.push(directory);
    git(directory, "init", "--quiet");
    git(directory, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "candidate");
    const checkedOutSha = git(directory, "rev-parse", "HEAD");
    const sourceGuard = action.runs.steps.find((step) => step.id === "source");
    expect(sourceGuard?.run).toBeDefined();

    const matches = spawnSync("bash", ["-euo", "pipefail", "-c", sourceGuard?.run ?? ""], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, EXPECTED_SHA: checkedOutSha, GITHUB_OUTPUT: join(directory, "output") },
    });
    expect(matches.status, matches.stdout + matches.stderr).toBe(0);
    expect(readFileSync(join(directory, "output"), "utf8")).toContain(`commit_sha=${checkedOutSha}`);

    const mismatch = spawnSync("bash", ["-euo", "pipefail", "-c", sourceGuard?.run ?? ""], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, EXPECTED_SHA: "a".repeat(40), GITHUB_OUTPUT: join(directory, "mismatch-output") },
    });
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stdout + mismatch.stderr).toContain("instead of requested source");
  });

});
