import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(".");

interface CircularFixture {
  directory: string;
  entryPaths: string[];
  rootDirectory: string;
  rootDirectoryCreated: boolean;
}

interface DependencyCruiserResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

function writeCircularFixture(rootDirectory: string): CircularFixture {
  const rootDirectoryCreated = !existsSync(rootDirectory);
  mkdirSync(rootDirectory, { recursive: true });
  const directory = mkdtempSync(join(rootDirectory, "dependency-cruiser-regression-"));
  const firstPath = join(directory, "first.js");
  const secondPath = join(directory, "second.js");
  writeFileSync(firstPath, `import "./${basename(secondPath)}";\n`);
  writeFileSync(secondPath, `import "./${basename(firstPath)}";\n`);
  return {
    directory,
    entryPaths: [firstPath, secondPath],
    rootDirectory,
    rootDirectoryCreated,
  };
}

function removeFixture(fixture: CircularFixture): void {
  rmSync(fixture.directory, { force: true, recursive: true });

  if (
    fixture.rootDirectoryCreated &&
    existsSync(fixture.rootDirectory) &&
    readdirSync(fixture.rootDirectory).length === 0
  ) {
    rmdirSync(fixture.rootDirectory);
  }
}

function runDependencyCruiser(entryPaths: string[]): Promise<DependencyCruiserResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const childProcess = spawn(
      "pnpm",
      ["exec", "depcruise", "--config", ".dependency-cruiser.cjs", ...entryPaths],
      {
        cwd: repositoryRoot,
        env: { ...process.env, FORCE_COLOR: "0" },
      },
    );
    let stderr = "";
    let stdout = "";

    childProcess.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    childProcess.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    childProcess.on("error", rejectPromise);
    childProcess.on("close", (status) => {
      resolvePromise({ status, stderr, stdout });
    });
  });
}

function commandOutput(result: DependencyCruiserResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

describe("dependency-cruiser command", () => {
  it("ignores generated web and Storybook bundles", async () => {
    const fixtures = [
      writeCircularFixture(resolve("packages/web/dist")),
      writeCircularFixture(resolve("packages/web/storybook-static")),
    ];

    try {
      const result = await runDependencyCruiser(
        fixtures.flatMap((fixture) =>
          fixture.entryPaths.map((fixturePath) => relative(repositoryRoot, fixturePath)),
        ),
      );

      expect(result.status, commandOutput(result)).toBe(0);
      expect(commandOutput(result)).toContain("no dependency violations found");
    } finally {
      for (const fixture of fixtures) {
        removeFixture(fixture);
      }
    }
  });

  it("continues to analyze web source files", async () => {
    const fixture = writeCircularFixture(resolve("packages/web/src"));

    try {
      const result = await runDependencyCruiser(
        fixture.entryPaths.map((fixturePath) => relative(repositoryRoot, fixturePath)),
      );
      const output = commandOutput(result);

      expect(result.status).not.toBe(0);
      expect(output).toContain("no-circular");
      expect(output).toContain(relative(repositoryRoot, fixture.entryPaths[0]));
    } finally {
      removeFixture(fixture);
    }
  });
});
