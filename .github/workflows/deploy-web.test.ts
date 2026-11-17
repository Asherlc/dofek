import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const sourceSha = "a".repeat(40);
const imageRef = `ghcr.io/asherlc/dofek@sha256:${"b".repeat(64)}`;
const job = (outputs: Record<string, string> = {}) => ({ result: "success", outputs });

function releaseInputs() {
  return {
    "resolve-commit": job({ commit_sha: sourceSha }),
    "detect-changes": job({
      docker_server: "true",
      web: "false",
      terraform: "false",
      docker_ota: "true",
      mobile: "true",
    }),
    "check-repository": job(),
    "check-shared": job(),
    "check-server": job(),
    "check-mobile": job(),
    "build-mobile": job(),
    "build-docker": job({ commit_sha: sourceSha, image_ref: imageRef }),
    "build-ota-publish": job(),
    "build-ios-release": job({
      should_deploy: "true",
      commit_sha: sourceSha,
      artifact_id: "123",
      build_number: "456",
    }),
  };
}

function selectRelease(inputs = releaseInputs(), runOverrides: Record<string, unknown> = {}) {
  const workflow = z
    .object({
      jobs: z.object({
        automatic: z.object({
          steps: z.array(
            z.object({
              id: z.string().optional(),
              run: z.string().optional(),
            }),
          ),
        }),
      }),
    })
    .parse(parse(readFileSync(".github/workflows/deploy-web.yml", "utf8")));
  const script = workflow.jobs.automatic.steps
    .find((step) => step.id === "select")
    ?.run?.split("<<'NODE'\n")[1]
    ?.replace(/\nNODE\s*$/, "");
  if (!script) throw new Error("Missing executable release selection step");
  const outputs: Record<string, string> = {};
  runInNewContext(script, {
    require: () => ({
      readFileSync: () => JSON.stringify(inputs),
      appendFileSync: (_path: string, value: string) => {
        const separator = value.indexOf("=");
        outputs[value.slice(0, separator)] = value.slice(separator + 1).trim();
      },
    }),
    process: {
      env: {
        RUNNER_TEMP: "/tmp/release-fixture",
        GITHUB_OUTPUT: "/tmp/output",
        GITHUB_REPOSITORY: "Asherlc/dofek",
        CI_RUN: JSON.stringify({
          event: "push",
          head_branch: "main",
          head_sha: sourceSha,
          status: "completed",
          path: ".github/workflows/ci.yml",
          head_repository: { full_name: "Asherlc/dofek" },
          ...runOverrides,
        }),
      },
    },
  });
  return outputs;
}

describe("automatic production release selection", () => {
  it("selects the tested commit and immutable builds even when main has advanced", () => {
    expect(selectRelease()).toMatchObject({
      source_sha: sourceSha,
      image_ref: imageRef,
      server_ready: "true",
      ota_ready: "true",
      ios_ready: "true",
      ios_artifact_id: "123",
      ios_build_number: "456",
    });
  });

  it.each([
    { event: "pull_request" },
    { event: "workflow_dispatch" },
    { head_branch: "feature" },
    { head_repository: { full_name: "fork/dofek" } },
    { status: "in_progress" },
    { path: ".github/workflows/other.yml" },
    { head_sha: "main" },
  ])("rejects an untrusted originating run: %j", (run) => {
    expect(() => selectRelease(releaseInputs(), run)).toThrow(/CI|source/i);
  });

  it("rejects a handoff from a different source", () => {
    const inputs = releaseInputs();
    inputs["resolve-commit"].outputs.commit_sha = "d".repeat(40);
    expect(() => selectRelease(inputs)).toThrow(/source/i);
  });

  it.each(["check-repository", "check-shared"] as const)(
    "blocks every target when %s fails",
    (name) => {
      const inputs = releaseInputs();
      inputs[name].result = "failure";
      expect(selectRelease(inputs)).toMatchObject({
        server_ready: "false",
        ota_ready: "false",
        ios_ready: "false",
      });
    },
  );

  it.each(["failure", "cancelled", "skipped"])(
    "blocks mobile on a %s mobile lane without blocking server",
    (result) => {
      const inputs = releaseInputs();
      inputs["check-mobile"].result = result;
      expect(selectRelease(inputs)).toMatchObject({
        server_ready: "true",
        ota_ready: "false",
        ios_ready: "false",
      });
    },
  );

  it.each(["check-server", "build-docker", "build-ota-publish"] as const)(
    "blocks server on failed %s without blocking mobile",
    (name) => {
      const inputs = releaseInputs();
      inputs[name].result = "failure";
      expect(selectRelease(inputs)).toMatchObject({
        server_ready: "false",
        ota_ready: "true",
        ios_ready: "true",
      });
    },
  );

  it("does not require the private OTA image build when it was not selected", () => {
    const inputs = releaseInputs();
    inputs["detect-changes"].outputs.docker_ota = "false";
    inputs["build-ota-publish"].result = "skipped";
    expect(selectRelease(inputs).server_ready).toBe("true");
  });

  it("blocks server when the image is absent, mutable, or from a different source", () => {
    for (const outputs of [
      { commit_sha: sourceSha, image_ref: "" },
      { commit_sha: sourceSha, image_ref: "ghcr.io/asherlc/dofek:latest" },
      { commit_sha: "d".repeat(40), image_ref: imageRef },
    ]) {
      const inputs = releaseInputs();
      inputs["build-docker"].outputs = outputs;
      expect(selectRelease(inputs)).toMatchObject({ server_ready: "false", ota_ready: "true" });
    }
  });

  it("keeps OTA independent when no new native archive is needed", () => {
    const inputs = releaseInputs();
    inputs["build-ios-release"].outputs = {
      should_deploy: "false",
      commit_sha: "",
      artifact_id: "",
      build_number: "",
    };
    expect(selectRelease(inputs)).toMatchObject({ ios_ready: "false", ota_ready: "true" });
  });

  it.each([{ artifact_id: "" }, { build_number: "" }, { commit_sha: "d".repeat(40) }])(
    "blocks iOS on incomplete or mismatched archive identity: %j",
    (identity) => {
      const inputs = releaseInputs();
      Object.assign(inputs["build-ios-release"].outputs, identity);
      expect(selectRelease(inputs)).toMatchObject({ ios_ready: "false", ota_ready: "true" });
    },
  );

  it("blocks all targets when change detection failed", () => {
    const inputs = releaseInputs();
    inputs["detect-changes"].result = "failure";
    expect(selectRelease(inputs)).toMatchObject({
      server_ready: "false",
      ota_ready: "false",
      ios_ready: "false",
    });
  });

  it("leaves unselected targets idle", () => {
    const inputs = releaseInputs();
    inputs["detect-changes"].outputs = {
      docker_server: "false",
      web: "false",
      terraform: "false",
      docker_ota: "false",
      mobile: "false",
    };
    expect(selectRelease(inputs)).toMatchObject({
      server_ready: "false",
      ota_ready: "false",
      ios_ready: "false",
    });
  });
});
