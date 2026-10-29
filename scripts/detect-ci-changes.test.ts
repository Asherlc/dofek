import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const changeOutputsSchema = z.object({
  analytics: z.boolean(),
  docker_ml: z.boolean(),
  docker_ota: z.boolean(),
  docker_server: z.boolean(),
  e2e_web: z.boolean(),
  ml: z.boolean(),
  mobile: z.boolean(),
  storybook_mobile: z.boolean(),
  storybook_web: z.boolean(),
  terraform: z.boolean(),
  web: z.boolean(),
  zepp: z.boolean(),
});

const detectorPath = resolve("scripts/detect-ci-changes.ts");

function detectChangedAreas(changedFile: string) {
  const result = spawnSync(
    resolve("node_modules/.bin/tsx"),
    [detectorPath, "--changed-file", changedFile, "--json"],
    {
      encoding: "utf8",
    },
  );

  expect(result.status, result.stderr).toBe(0);
  return changeOutputsSchema.parse(JSON.parse(result.stdout));
}

describe("CI change detector", () => {
  it.each([
    "deploy/ota/Dockerfile",
    "deploy/ota/upstream.patch",
    ".github/workflows/build-ota.yml",
    "scripts/check-ota-image-visibility.ts",
    "package.json",
    "pnpm-lock.yaml",
  ])("selects the OTA image for its build input %s", (changedFile) => {
    expect(detectChangedAreas(changedFile).docker_ota).toBe(true);
  });

  it("runs the OTA image for critical CI changes", () => {
    expect(detectChangedAreas(".github/workflows/ci.yml").docker_ota).toBe(true);
  });

  it("keeps unrelated application changes outside the OTA image scope", () => {
    expect(detectChangedAreas("packages/web/src/App.tsx").docker_ota).toBe(false);
  });

  it.each([
    "packages/mobile/modules/whoop-ble/ios/WhoopBleConnectionManager.swift",
    "packages/mobile/modules/whoop-ble/index.ts",
  ])("runs mobile surfaces for the local native module path %s", (changedFile) => {
    expect(detectChangedAreas(changedFile)).toEqual({
      analytics: false,
      docker_ml: false,
      docker_ota: false,
      docker_server: false,
      e2e_web: false,
      ml: false,
      mobile: true,
      storybook_mobile: true,
      storybook_web: false,
      terraform: false,
      web: false,
      zepp: false,
    });
  });

  it("keeps local native module documentation changes outside mobile scope", () => {
    expect(detectChangedAreas("packages/mobile/modules/whoop-ble/README.md")).toEqual({
      analytics: false,
      docker_ml: false,
      docker_ota: false,
      docker_server: false,
      e2e_web: false,
      ml: false,
      mobile: false,
      storybook_mobile: false,
      storybook_web: false,
      terraform: false,
      web: false,
      zepp: false,
    });
  });

  it("runs mobile and server surfaces for an IMU package change", () => {
    expect(detectChangedAreas("packages/imu/src/sample.ts")).toEqual(
      expect.objectContaining({
        docker_server: true,
        e2e_web: true,
        ml: false,
        mobile: true,
        web: true,
        zepp: false,
      }),
    );
  });

  it("runs web and server surfaces for a filter-columns package change", () => {
    expect(detectChangedAreas("packages/filter-columns/src/filter.ts")).toEqual(
      expect.objectContaining({
        docker_server: true,
        e2e_web: true,
        ml: false,
        mobile: true,
        web: true,
        zepp: false,
      }),
    );
  });

  it.each(["eight-sleep", "trainerroad-client", "whoop-whoop", "zepp-client", "zwift-client"])(
    "runs server image and E2E surfaces for %s",
    (packageDirectory) => {
      expect(detectChangedAreas(`packages/${packageDirectory}/src/client.ts`)).toEqual(
        expect.objectContaining({
          docker_server: true,
          e2e_web: true,
          ml: false,
          mobile: true,
          web: true,
          zepp: packageDirectory === "zepp-client",
        }),
      );
    },
  );

  it("does not run application builds for an unrelated package change", () => {
    expect(detectChangedAreas("packages/trainingpeaks-connect/src/client.ts")).toEqual(
      expect.objectContaining({
        docker_server: false,
        e2e_web: false,
        ml: false,
        mobile: false,
        web: false,
        zepp: false,
      }),
    );
  });
});
