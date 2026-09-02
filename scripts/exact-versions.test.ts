import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const checkerPath = resolve("scripts/exact-versions.ts");
const fixtureDirectories: string[] = [];

function createWorkspace(
  dependencySections: Record<
    "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies",
    Record<string, string>
  >,
): string {
  const workspaceDirectory = mkdtempSync(resolve(tmpdir(), "exact-versions-test-"));
  fixtureDirectories.push(workspaceDirectory);
  mkdirSync(resolve(workspaceDirectory, "packages", "fixture"), { recursive: true });
  writeFileSync(
    resolve(workspaceDirectory, "pnpm-workspace.yaml"),
    "packages:\n  - .\n  - packages/*\n",
  );
  writeFileSync(
    resolve(workspaceDirectory, "package.json"),
    JSON.stringify({ name: "fixture-root" }),
  );
  writeFileSync(
    resolve(workspaceDirectory, "packages", "fixture", "package.json"),
    JSON.stringify({
      name: "fixture-package",
      ...dependencySections,
    }),
  );
  return workspaceDirectory;
}

function runChecker(workspaceDirectory: string) {
  return spawnSync("pnpm", ["exec", "tsx", checkerPath, workspaceDirectory], {
    cwd: resolve("."),
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const fixtureDirectory of fixtureDirectories.splice(0)) {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

describe("exact dependency version checker", () => {
  it("accepts exact and workspace protocol declarations in every dependency section", () => {
    const workspaceDirectory = createWorkspace({
      dependencies: {
        "exact-dependency": "1.2.3",
        "workspace-dependency": "workspace:^",
      },
      devDependencies: {
        "exact-dev-dependency": "2.3.4",
        "workspace-dev-dependency": "workspace:~",
      },
      optionalDependencies: {
        "exact-optional-dependency": "3.4.5",
        "workspace-optional-dependency": "workspace:*",
      },
      peerDependencies: {
        "exact-peer-dependency": "4.5.6",
        "workspace-peer-dependency": "workspace:1.0.0",
      },
    });

    const result = runChecker(workspaceDirectory);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("All dependency versions are exact.");
  });

  it.each([
    ["dependencies", "^1.2.3"],
    ["dependencies", "~1.2.3"],
    ["devDependencies", "^1.2.3"],
    ["devDependencies", "~1.2.3"],
    ["optionalDependencies", "^1.2.3"],
    ["optionalDependencies", "~1.2.3"],
    ["peerDependencies", "^1.2.3"],
    ["peerDependencies", "~1.2.3"],
  ] as const)("rejects %s declaration %s", (section, version) => {
    const dependencySections = {
      dependencies: {},
      devDependencies: {},
      optionalDependencies: {},
      peerDependencies: {},
    };
    dependencySections[section] = { "ranged-dependency": version };
    const workspaceDirectory = createWorkspace(dependencySections);

    const result = runChecker(workspaceDirectory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("packages/fixture/package.json");
    expect(result.stderr).toContain(`ranged-dependency: ${version}`);
  });

  it("checks the workspace root manifest", () => {
    const workspaceDirectory = createWorkspace({
      dependencies: {},
      devDependencies: {},
      optionalDependencies: {},
      peerDependencies: {},
    });
    writeFileSync(
      resolve(workspaceDirectory, "package.json"),
      JSON.stringify({
        name: "fixture-root",
        dependencies: { "root-ranged-dependency": "^1.2.3" },
      }),
    );

    const result = runChecker(workspaceDirectory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("package.json");
    expect(result.stderr).toContain("root-ranged-dependency: ^1.2.3");
  });
});
