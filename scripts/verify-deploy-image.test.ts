import { describe, expect, it } from "vitest";
import {
  deployTestDigest,
  deployTestOldImage,
  deployTestRepository,
  runDeployImageFixture,
} from "./deploy-image-test-helpers.ts";

const image = `${deployTestRepository}@${deployTestDigest}`;
function verify(overrides: Partial<Parameters<typeof runDeployImageFixture>[0]> = {}) {
  return runDeployImageFixture({
    filename: "verify-deploy-image.ts",
    args: [image, "dofek_web"],
    desiredImage: image,
    taskImages: [image],
    ...overrides,
  });
}

describe("verify-deploy-image", () => {
  it("accepts tagged service and task references to the same manifest digest", () => {
    const tagged = `${deployTestRepository}:requested@${deployTestDigest}`;
    const result = verify({
      desiredImage: tagged,
      taskImages: [image, tagged],
      desiredReplicas: 2,
    });
    expect(result.status, result.stderr).toBe(0);
  });
  it("rejects an old desired manifest even with a healthy service", () => {
    const result = verify({ desiredImage: deployTestOldImage });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("desired image");
  });
  it("rejects an old running task even when the desired manifest matches", () => {
    const result = verify({ taskImages: [image, deployTestOldImage], desiredReplicas: 2 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("task task1");
  });
  it("rejects a pending desired task", () => {
    const result = verify({ taskState: "starting" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("is starting");
  });
  it("checks desired identity for a quiesced service with no running tasks", () => {
    const result = verify({ taskImages: [], desiredReplicas: 0 });
    expect(result.status, result.stderr).toBe(0);
  });
  it("rejects missing replica metadata instead of treating it as quiescence", () => {
    const result = verify({ taskImages: [], desiredReplicas: "" });
    expect(result.status).not.toBe(0);
  });
  it.each([[], [image], [image, image, image]])(
    "rejects missing or extra desired-running tasks %j",
    (...taskImages) => {
      const result = verify({ taskImages, desiredReplicas: 2 });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("requires 2 running tasks");
    },
  );
  it.each(["service inspect", "service ps", "inspect --type"])(
    "propagates %s errors",
    (failure) => {
      const result = verify({ failure });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Docker unavailable");
    },
  );
});
