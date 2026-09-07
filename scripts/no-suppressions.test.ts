import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const policyScript = path.resolve("scripts/no-suppressions.ts");
const tsxCli = require.resolve("tsx/cli");
const temporaryRepositories: string[] = [];

const forbiddenSuppressions = [
  ["@", "ts-ignore"].join(""),
  ["@", "ts-expect-error"].join(""),
  ["@", "ts-nocheck"].join(""),
  ["biome", "-ignore"].join(""),
  ["eslint", "-disable"].join(""),
  ["Stryker", " disable"].join(""),
  ["istanbul", " ignore"].join(""),
  ["c8", " ignore"].join(""),
];

function createRepository(files: Record<string, string>): string {
  const repositoryPath = mkdtempSync(path.join(tmpdir(), "no-suppressions-"));
  temporaryRepositories.push(repositoryPath);

  for (const directoryPath of ["src", "packages/fixture/src", "scripts", "cypress"]) {
    mkdirSync(path.join(repositoryPath, directoryPath), { recursive: true });
  }

  for (const [filePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(repositoryPath, filePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
  }

  const initialization = spawnSync("git", ["init", "--quiet"], {
    cwd: repositoryPath,
    encoding: "utf8",
  });
  expect(initialization.status).toBe(0);

  const staging = spawnSync("git", ["add", "."], {
    cwd: repositoryPath,
    encoding: "utf8",
  });
  expect(staging.status).toBe(0);

  return repositoryPath;
}

function runPolicy(repositoryPath: string) {
  return spawnSync(process.execPath, [tsxCli, policyScript], {
    cwd: repositoryPath,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const repositoryPath of temporaryRepositories.splice(0)) {
    rmSync(repositoryPath, { recursive: true, force: true });
  }
});

describe("repository suppression policy", () => {
  it.each([
    ["mobile application", "packages/mobile/app/example.tsx"],
    ["mobile component", "packages/mobile/components/example.tsx"],
    ["package root", "packages/zepp/app.ts"],
    ["server source", "src/example.ts"],
  ])("rejects forbidden comments in %s files", (_label, filePath) => {
    const repositoryPath = createRepository({
      [filePath]: `${forbiddenSuppressions.map((value) => `// ${value}`).join("\n")}\n`,
    });

    const result = runPolicy(repositoryPath);

    expect(result.status).toBe(1);
    for (const forbiddenSuppression of forbiddenSuppressions) {
      expect(result.stderr).toContain(`${filePath}:`);
      expect(result.stderr).toContain(forbiddenSuppression);
    }
  });

  it("accepts forbidden comments only in generated route trees", () => {
    const repositoryPath = createRepository({
      "packages/web/src/routeTree.gen.ts": `// ${forbiddenSuppressions[2]}\n`,
      "src/valid.ts": "export const value = true;\n",
    });

    const result = runPolicy(repositoryPath);

    expect(result.status).toBe(0);
  });

  it("ignores untracked files", () => {
    const repositoryPath = createRepository({
      "src/tracked.ts": "export const value = true;\n",
    });
    writeFileSync(
      path.join(repositoryPath, "src/untracked.ts"),
      `// ${forbiddenSuppressions[0]}\n`,
    );

    const result = runPolicy(repositoryPath);

    expect(result.status).toBe(0);
  });

  it("ignores tracked files deleted in the working tree", () => {
    const repositoryPath = createRepository({
      "src/deleted.ts": "export const removed = true;\n",
      "src/remaining.ts": "export const value = true;\n",
    });
    rmSync(path.join(repositoryPath, "src/deleted.ts"));

    const result = runPolicy(repositoryPath);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No suppression comments found.");
  });
});
