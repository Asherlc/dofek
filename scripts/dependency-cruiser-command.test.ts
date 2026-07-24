import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(".");

interface DependencyCruiserResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

function writeCircularFixture(firstPath: string, secondPath: string): string[] {
  mkdirSync(dirname(firstPath), { recursive: true });
  writeFileSync(firstPath, `import "./${basename(secondPath)}";\n`);
  writeFileSync(secondPath, `import "./${basename(firstPath)}";\n`);
  return [firstPath, secondPath];
}

function removeFixture(paths: string[]): void {
  for (const path of paths) {
    rmSync(path, { force: true });
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
    const fixturePaths = [
      ...writeCircularFixture(
        resolve("packages/web/dist/dependency-cruiser-regression-first.js"),
        resolve("packages/web/dist/dependency-cruiser-regression-second.js"),
      ),
      ...writeCircularFixture(
        resolve("packages/web/storybook-static/dependency-cruiser-regression-first.js"),
        resolve("packages/web/storybook-static/dependency-cruiser-regression-second.js"),
      ),
    ];

    try {
      const result = await runDependencyCruiser(
        fixturePaths.map((fixturePath) => relative(repositoryRoot, fixturePath)),
      );

      expect(result.status, commandOutput(result)).toBe(0);
      expect(commandOutput(result)).toContain("no dependency violations found");
    } finally {
      removeFixture(fixturePaths);
    }
  });

  it("continues to analyze web source files", async () => {
    const fixturePaths = writeCircularFixture(
      resolve("packages/web/src/dependency-cruiser-regression-first.js"),
      resolve("packages/web/src/dependency-cruiser-regression-second.js"),
    );

    try {
      const result = await runDependencyCruiser(
        fixturePaths.map((fixturePath) => relative(repositoryRoot, fixturePath)),
      );
      const output = commandOutput(result);

      expect(result.status).not.toBe(0);
      expect(output).toContain("no-circular");
      expect(output).toContain("packages/web/src/dependency-cruiser-regression-first.js");
    } finally {
      removeFixture(fixturePaths);
    }
  });
});
