import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const workflow = z
  .object({
    jobs: z.object({
      build: z.object({
        steps: z.array(
          z.object({
            id: z.string().optional(),
            name: z.string().optional(),
            run: z.string().optional(),
            with: z.object({ tags: z.string().optional() }).optional(),
          }),
        ),
      }),
    }),
  })
  .parse(parse(readFileSync(".github/workflows/build-private-ota.yml", "utf8")));
const ciWorkflow = z
  .object({
    jobs: z.object({
      "build-ota": z.object({ permissions: z.object({ packages: z.enum(["read", "write"]) }), if: z.string() }),
      "build-ota-publish": z.object({ permissions: z.object({ packages: z.enum(["read", "write"]) }), if: z.string() }),
    }),
  })
  .parse(parse(readFileSync(".github/workflows/ci.yml", "utf8")));

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

describe("private OTA image source", () => {
  it("keeps registry write permission on the main-only publisher", () => {
    expect(ciWorkflow.jobs["build-ota"].permissions.packages).toBe("read");
    expect(ciWorkflow.jobs["build-ota-publish"].permissions.packages).toBe("write");
    expect(ciWorkflow.jobs["build-ota-publish"].if).toContain("github.ref == 'refs/heads/main'");
  });

  it("requires the checkout to match the selected full source SHA before building", () => {
    const directory = mkdtempSync(join(tmpdir(), "dofek-ota-source-"));
    temporaryDirectories.push(directory);
    git(directory, "init", "--quiet");
    git(directory, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "candidate");
    const checkedOutSha = git(directory, "rev-parse", "HEAD");
    const sourceGuard = workflow.jobs.build.steps.find((step) => step.id === "source");
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

  it("tags the published private image with the selected checked-out source", () => {
    const tag = workflow.jobs.build.steps.find((step) => step.id === "runtime")?.with?.tags;
    expect(tag).toBe("${{ steps.image.outputs.name }}:sha-${{ steps.source.outputs.commit_sha }}");
  });
});
