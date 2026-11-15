import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const workflowSchema = z.object({
  jobs: z.record(
    z.string(),
    z.object({
      steps: z
        .array(
          z.object({
            name: z.string().optional(),
            run: z.string().optional(),
          }),
        )
        .optional(),
    }),
  ),
});

function readGate(workflowFile: string, jobName: string, stepName: string): string {
  const workflow = workflowSchema.parse(parse(readFileSync(resolve(workflowFile), "utf8")));
  const step = workflow.jobs[jobName]?.steps?.find((candidate) => candidate.name === stepName);
  if (!step?.run) throw new Error(`Missing runtime gate ${workflowFile}:${jobName}:${stepName}`);
  return step.run;
}

function runGate(
  script: string,
  environment: Record<string, string>,
  needsResults: Record<string, string> = {},
) {
  const renderedScript = script.replace(
    /\$\{\{\s*needs\.([a-z0-9-]+)\.result\s*\}\}/g,
    (_expression, jobName: string) => needsResults[jobName] ?? "missing",
  );
  return spawnSync("bash", ["-e", "-o", "pipefail", "-c", renderedScript], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

const ciGate = readGate(".github/workflows/ci.yml", "ci-gate", "Check all CI results");
const testGate = readGate(".github/workflows/test.yml", "test-all-gate", "Check all test results");
const sharedGate = readGate(".github/workflows/check-shared.yml", "shared-checks", "Check results");

const successfulCi = {
  BUILD_MOBILE_RESULT: "success",
  BUILD_OTA_RESULT: "skipped",
  BUILD_STORYBOOK_MOBILE_RESULT: "skipped",
  BUILD_STORYBOOK_RESULT: "skipped",
  BUILD_WEB_RESULT: "skipped",
  BUILD_ZEPP_RESULT: "skipped",
  DEPENDABOT: "false",
  DETECT_RESULT: "success",
  MOBILE_RESULT: "skipped",
  MOBILE_SELECTED: "false",
  OTA_SELECTED: "false",
  REPOSITORY_RESULT: "success",
  RESOLVE_RESULT: "success",
  SERVER_RESULT: "skipped",
  SERVER_SELECTED: "false",
  SHARED_RESULT: "skipped",
  SHARED_SELECTED: "false",
  STORYBOOK_PREVIEW_RESULT: "skipped",
  STORYBOOK_SELECTED: "false",
  TEST_RESULT: "success",
  WEB_SELECTED: "false",
  ZEPP_SELECTED: "false",
};

describe("runtime Actions result gates", () => {
  it.each(["failure", "cancelled", "skipped"])(
    "blocks a selected server lane whose result is %s",
    (result) => {
      const outcome = runGate(ciGate, {
        ...successfulCi,
        SERVER_RESULT: result,
        SERVER_SELECTED: "true",
      });

      expect(outcome.status, outcome.stderr).toBe(1);
    },
  );

  it("accepts an expected unselected lane skip", () => {
    const outcome = runGate(ciGate, successfulCi);

    expect(outcome.status, outcome.stderr).toBe(0);
  });

  it("does not make Docker image publishers new merge gates", () => {
    const outcome = runGate(ciGate, {
      ...successfulCi,
      BUILD_DOCKER_RESULT: "skipped",
      BUILD_DOCKER_ML_RESULT: "skipped",
      DOCKER_SERVER: "true",
      DOCKER_ML_SELECTED: "true",
    });

    expect(outcome.status, outcome.stderr).toBe(0);
  });

  it("requires selected Storybook builds without requiring preview publication", () => {
    const outcome = runGate(ciGate, {
      ...successfulCi,
      BUILD_STORYBOOK_RESULT: "success",
      BUILD_STORYBOOK_MOBILE_RESULT: "success",
      STORYBOOK_PREVIEW_RESULT: "failure",
      STORYBOOK_SELECTED: "true",
    });

    expect(outcome.status, outcome.stderr).toBe(0);
  });

  it("requires successful change detection", () => {
    const outcome = runGate(ciGate, { ...successfulCi, DETECT_RESULT: "failure" });

    expect(outcome.status, outcome.stderr).toBe(1);
  });

  it("blocks a selected shared check that skipped", () => {
    const outcome = runGate(
      testGate,
      {
        REPOSITORY_RESULT: "success",
        SHARED_RESULT: "skipped",
        SHARED_SELECTED: "true",
        SERVER_RESULT: "skipped",
        SERVER_SELECTED: "false",
        MOBILE_RESULT: "skipped",
        MOBILE_SELECTED: "false",
      },
      {
        "security-gate": "success",
        "quality-gate": "failure",
        "test-gate": "success",
        "test-e2e-web": "success",
        "mutation-gate": "success",
      },
    );

    expect(outcome.status, outcome.stderr).toBe(1);
  });

  it("blocks missing shared mutation shard output when mutation workers skipped", () => {
    const outcome = runGate(
      sharedGate,
      { MUTATION_SHARDS: "" },
      {
        typecheck: "success",
        "test-unit-shared": "success",
        "import-boundaries": "success",
        "review-scenarios": "success",
        "mutation-shared-prep": "success",
        "mutation-shared": "skipped",
      },
    );

    expect(outcome.status, outcome.stderr).toBe(1);
  });

  it("accepts a complete empty shared mutation selection", () => {
    const outcome = runGate(
      sharedGate,
      { MUTATION_SHARDS: "[]" },
      {
        typecheck: "success",
        "test-unit-shared": "success",
        "import-boundaries": "success",
        "review-scenarios": "success",
        "mutation-shared-prep": "success",
        "mutation-shared": "skipped",
      },
    );

    expect(outcome.status, outcome.stderr).toBe(0);
  });
});
