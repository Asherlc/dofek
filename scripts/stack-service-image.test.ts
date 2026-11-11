import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const image = `ghcr.io/example/ota@sha256:${"a".repeat(64)}`;
const script = fileURLToPath(new URL("./stack-service-image.ts", import.meta.url));
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "stack-image-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function run(configuration: string, service = "ota") {
  const path = join(directory, "stack.yml");
  writeFileSync(path, configuration);
  return spawnSync("pnpm", ["tsx", script, path, service], { encoding: "utf8" });
}

describe("stack service image CLI", () => {
  it("reads the immutable image for the requested service", () => {
    const result = run(
      `services:\n  web:\n    image: unrelated:latest\n  ota:\n    image: ${image}\n`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(image);
  });

  it("resolves Compose YAML merge keys", () => {
    const result = run(
      `x-runtime: &runtime\n  image: ${image}\nservices:\n  ota:\n    <<: *runtime\n`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(image);
  });

  it.each(["services: {}", "services:\n  ota:\n    environment: {}"])(
    "fails clearly when the service image is missing: %s",
    (configuration) => {
      const result = run(configuration);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("services.ota.image");
    },
  );

  it("rejects mutable image tags before deployment verification", () => {
    const result = run("services:\n  ota:\n    image: ghcr.io/example/ota:latest\n");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("immutable");
  });
});
