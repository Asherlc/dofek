import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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

const noChanges = {
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
};

const allChanges = {
  analytics: true,
  docker_ml: true,
  docker_ota: true,
  docker_server: true,
  e2e_web: true,
  ml: true,
  mobile: true,
  storybook_mobile: true,
  storybook_web: true,
  terraform: true,
  web: true,
  zepp: true,
};

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function runDetector(argumentsToPass: string[]) {
  return spawnSync(resolve("node_modules/.bin/tsx"), [detectorPath, ...argumentsToPass], {
    encoding: "utf8",
  });
}

function detectChangedAreas(changedFile: string) {
  const result = runDetector(["--changed-file", changedFile, "--json"]);

  expect(result.status, result.stderr).toBe(0);
  return changeOutputsSchema.parse(JSON.parse(result.stdout));
}

function writeFixtureFile(directory: string, filePath: string, contents: string) {
  const absolutePath = join(directory, filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function createRepositoryFixture(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "detect-ci-changes-"));
  temporaryDirectories.push(directory);
  for (const [filePath, contents] of Object.entries(files)) {
    writeFixtureFile(directory, filePath, contents);
  }

  const git = (...argumentsToPass: string[]) =>
    execFileSync("git", argumentsToPass, { cwd: directory, encoding: "utf8" });
  git("init", "--initial-branch=main");
  git("config", "user.email", "detector@example.test");
  git("config", "user.name", "Detector Test");
  git("config", "commit.gpgsign", "false");

  return {
    commitAll: (message: string) => {
      git("add", "--all");
      git("commit", "--message", message);
      return git("rev-parse", "HEAD").trim();
    },
    directory,
    git,
  };
}

function detectDiff(directory: string, diffRange: string) {
  const result = runDetector(["--workspace", directory, "--diff-range", diffRange, "--json"]);

  expect(result.status, result.stderr).toBe(0);
  return changeOutputsSchema.parse(JSON.parse(result.stdout));
}

const workspaceFiles = {
  "package.json": JSON.stringify({ name: "dofek" }),
  "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
  "packages/mobile/package.json": JSON.stringify({
    dependencies: { "@dofek/shared": "workspace:*", "dofek-server": "workspace:*" },
    name: "dofek-mobile",
  }),
  "packages/server/package.json": JSON.stringify({
    dependencies: { "@dofek/shared": "workspace:*" },
    name: "dofek-server",
  }),
  "packages/shared/package.json": JSON.stringify({ name: "@dofek/shared" }),
  "packages/web/package.json": JSON.stringify({
    dependencies: { "dofek-server": "workspace:*" },
    name: "dofek-web",
  }),
};

describe("CI change detector", () => {
  it.each([
    "deploy/ota/Dockerfile",
    "deploy/ota/upstream.patch",
    ".github/workflows/build-private-ota.yml",
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

describe("independent lane selection", () => {
  it("selects mobile validation without a server release for mobile code", () => {
    expect(detectChangedAreas("packages/mobile/src/screens/Today.tsx")).toEqual(
      expect.objectContaining({
        docker_server: false,
        e2e_web: false,
        mobile: true,
        web: false,
      }),
    );
  });

  it("selects mobile typechecks for a server API change", () => {
    expect(detectChangedAreas("packages/server/src/api/router.ts")).toEqual(
      expect.objectContaining({
        docker_server: true,
        e2e_web: true,
        mobile: true,
        web: true,
      }),
    );
  });

  it.each(["docs/README.md", "docs/testing.md"])(
    "selects no application build for documentation %s",
    (changedFile) => {
      expect(detectChangedAreas(changedFile)).toEqual(noChanges);
    },
  );

  it("keeps repository-only checks outside application builds", () => {
    expect(detectChangedAreas(".github/workflows/check-repository.yml")).toEqual(noChanges);
  });

  it("selects shared application consumers for the shared check workflow", () => {
    expect(detectChangedAreas(".github/workflows/check-shared.yml")).toEqual({
      ...noChanges,
      docker_server: true,
      e2e_web: true,
      mobile: true,
      storybook_mobile: true,
      storybook_web: true,
      web: true,
    });
  });

  it("selects server, web, and E2E ownership for the server check workflow", () => {
    expect(detectChangedAreas(".github/workflows/check-server.yml")).toEqual({
      ...noChanges,
      docker_server: true,
      e2e_web: true,
      storybook_web: true,
      web: true,
    });
  });

  it("selects mobile ownership for the mobile check workflow", () => {
    expect(detectChangedAreas(".github/workflows/check-mobile.yml")).toEqual({
      ...noChanges,
      mobile: true,
      storybook_mobile: true,
    });
  });

  it.each([
    ".github/workflows/ci.yml",
    ".github/workflows/test.yml",
    ".github/workflows/detect-changes.yml",
    "scripts/detect-ci-changes.ts",
  ])("selects every lane for critical orchestration change %s", (changedFile) => {
    expect(detectChangedAreas(changedFile)).toEqual(allChanges);
  });

  it.each([
    ".github/actions/setup-node-pnpm/action.yml",
    "vitest.config.ts",
    "vitest.config.mutation.ts",
    "stryker.ci.config.json",
    "mise.toml",
    "mise.lock",
    ".nvmrc",
    "biome.json",
    "package.json",
    "pnpm-lock.yaml",
  ])("selects every lane for shared repository input %s", (changedFile) => {
    expect(detectChangedAreas(changedFile)).toEqual(allChanges);
  });
});

describe("diff-range selection", () => {
  it("selects both source and destination owners of a rename and a deletion", () => {
    const fixture = createRepositoryFixture({
      ...workspaceFiles,
      "packages/mobile/src/removed.ts": "export const removed = true;\n",
      "packages/server/src/keep.ts": "export const keep = true;\n",
      "packages/web/src/legacy.ts": "export const legacy = true;\n",
    });
    const baseRevision = fixture.commitAll("base");

    fixture.git("mv", "packages/web/src/legacy.ts", "packages/mobile/src/legacy.ts");
    fixture.git("rm", "packages/mobile/src/removed.ts");
    fixture.commitAll("rename web input into mobile and delete mobile input");

    expect(detectDiff(fixture.directory, `${baseRevision}...HEAD`)).toEqual(
      expect.objectContaining({
        docker_server: false,
        mobile: true,
        web: true,
      }),
    );
  });

  it("selects a multi-commit push and its shared package consumers", () => {
    const fixture = createRepositoryFixture(workspaceFiles);
    const baseRevision = fixture.commitAll("base");

    writeFixtureFile(
      fixture.directory,
      "packages/shared/src/index.ts",
      "export const shared = 1;\n",
    );
    fixture.commitAll("shared package change");
    writeFixtureFile(fixture.directory, "packages/mobile/src/App.tsx", "export const app = 1;\n");
    fixture.commitAll("mobile application change");

    expect(detectDiff(fixture.directory, `${baseRevision}...HEAD`)).toEqual(
      expect.objectContaining({
        docker_server: true,
        e2e_web: true,
        mobile: true,
        web: true,
      }),
    );
  });

  it.each([
    ["a missing diff range value", ["--diff-range"]],
    ["a missing changed file value", ["--changed-file"]],
  ])("fails for %s instead of producing outputs", (_description, argumentsToPass) => {
    const result = runDetector(argumentsToPass);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it("fails for an unknown diff revision instead of producing outputs", () => {
    const fixture = createRepositoryFixture(workspaceFiles);
    fixture.commitAll("base");

    const result = runDetector([
      "--workspace",
      fixture.directory,
      "--diff-range",
      "missing-revision...HEAD",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});
