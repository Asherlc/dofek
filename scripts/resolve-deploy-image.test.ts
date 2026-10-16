import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  deployTestDigest,
  deployTestOldImage,
  deployTestRepository,
  runDeployImageFixture,
} from "./deploy-image-test-helpers.ts";

const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const args = [`${deployTestRepository}:requested`, commit, "dofek_web"];

describe("resolve-deploy-image", () => {
  it("validates the pinned image after its tag moves and preserves the old desired reference", () => {
    const result = runDeployImageFixture({ args });
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe(
      `image_ref=${deployTestRepository}@${deployTestDigest}\npre_migration_image_ref=${deployTestOldImage}\nsentry_release=${commit}\n`,
    );
    expect(result.calls).toContainEqual([
      "image",
      "inspect",
      `${deployTestRepository}@${deployTestDigest}`,
      "--format",
      "{{json .Config.Env}}",
    ]);
  });

  it("uses the pinned requested image for an absent web service", () => {
    const result = runDeployImageFixture({ args, desiredImage: "" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain(
      `pre_migration_image_ref=${deployTestRepository}@${deployTestDigest}\n`,
    );
  });

  it.each(["service ls", "service inspect", "buildx imagetools", "image inspect"])(
    "propagates %s failure without publishing a deployment selection",
    (failure) => {
      const result = runDeployImageFixture({ args, failure });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Docker unavailable");
      expect(result.output).toBe("");
    },
  );

  it.each([
    `${deployTestRepository}:previous`,
    `other.example/app@${deployTestDigest}`,
    `${deployTestRepository}@sha256:bad`,
  ])("rejects an unsafe existing desired reference %s", (desiredImage) => {
    const result = runDeployImageFixture({ args, desiredImage });
    expect(result.status).not.toBe(0);
    expect(result.output).toBe("");
    expect(result.calls.some((call) => call[0] === "pull")).toBe(false);
  });

  it.each([null, "sha256:bad", `sha256:${"a".repeat(64)}\ninjected=value`])(
    "rejects malformed registry digest %s",
    (digest) => {
      const result = runDeployImageFixture({ args, digest });
      expect(result.status).not.toBe(0);
      expect(result.output).toBe("");
      expect(result.calls.some((call) => call[0] === "pull")).toBe(false);
    },
  );

  it.each(["", commit.slice(0, 7), "c".repeat(40)])(
    "rejects a missing, abbreviated or mismatched image release %s",
    (release) => {
      const result = runDeployImageFixture({ args, release });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("does not match image SENTRY_RELEASE");
      expect(result.output).toBe("");
    },
  );

  it("requires a full source commit before invoking Docker", () => {
    const result = runDeployImageFixture({
      args: [args[0] ?? "", commit.slice(0, 7), "dofek_web"],
    });
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
  });
});
