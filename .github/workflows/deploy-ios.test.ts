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

describe("signed iOS archive artifact validation", () => {
  const workflow = parse(readFileSync(".github/workflows/build-ios-release.yml", "utf8")) as {
    jobs: { archive: { steps: Array<{ name?: string; run?: string }> } };
  };
  const script = workflow.jobs.archive.steps.find(
    (step) => step.name === "Validate signed archive identity",
  )?.run;

  it.each([
    ["matching source and complete artifact identity", "a".repeat(40), "a".repeat(40), "1784160000", "1234", 0],
    ["missing archive source", "a".repeat(40), "", "1784160000", "1234", 1],
    ["different archive source", "a".repeat(40), "b".repeat(40), "1784160000", "1234", 1],
    ["missing build number", "a".repeat(40), "a".repeat(40), "", "1234", 1],
    ["missing artifact ID", "a".repeat(40), "a".repeat(40), "1784160000", "", 1],
  ])("handles %s before exposing archive outputs", (_name, expectedSha, actualSha, buildNumber, artifactId, status) => {
    expect(script).toBeDefined();
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script ?? ""], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        EXPECTED_SHA: expectedSha,
        ARCHIVE_SHA: actualSha,
        BUILD_NUMBER: buildNumber,
        ARTIFACT_ID: artifactId,
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(status);
  });
});
