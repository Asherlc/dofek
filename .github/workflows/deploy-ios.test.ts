import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

describe("TestFlight archive source validation", () => {
  it("validates the selected mobile source independently of the server source", () => {
    const workflow = z
      .object({
        jobs: z.object({
          deploy: z.object({
            steps: z.array(z.object({ name: z.string().optional(), run: z.string().optional() })),
          }),
        }),
      })
      .parse(parse(readFileSync(".github/workflows/deploy-ios.yml", "utf8")));
    const script = workflow.jobs.deploy.steps[0]?.run;
    const mobileSha = "b".repeat(40);
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script ?? ""], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        COMMIT_SHA: "a".repeat(40),
        MOBILE_COMMIT_SHA: mobileSha,
        ARCHIVE_COMMIT_SHA: mobileSha,
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it.each([
    ["matching mobile source", "a".repeat(40), "a".repeat(40), 0],
    ["different mobile source", "a".repeat(40), "b".repeat(40), 1],
    ["missing mobile source", "", "a".repeat(40), 1],
    ["short mobile source", "a".repeat(7), "a".repeat(40), 1],
    ["missing archive source", "a".repeat(40), "", 1],
    ["short archive source", "a".repeat(40), "a".repeat(7), 1],
    ["matching malformed sources", "z".repeat(40), "z".repeat(40), 1],
  ])("handles %s before upload setup", (_name, mobileSha, archiveSha, status) => {
    const workflow = z
      .object({
        jobs: z.object({
          deploy: z.object({
            steps: z.array(z.object({ name: z.string().optional(), run: z.string().optional() })),
          }),
        }),
      })
      .parse(parse(readFileSync(".github/workflows/deploy-ios.yml", "utf8")));
    const script = workflow.jobs.deploy.steps[0]?.run;
    expect(script).toBeDefined();
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script ?? ""], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        MOBILE_COMMIT_SHA: mobileSha,
        ARCHIVE_COMMIT_SHA: archiveSha,
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(status);
    if (status !== 0) expect(result.stdout + result.stderr).toContain("::error::");
  });
});
