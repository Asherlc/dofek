import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

const scriptPath = resolve("scripts/prepare-mutation-shards.ts");
const passingTestSource =
  'import { expect, it } from "vitest";\nit("acts as a colocated unit test", () => expect(1).toBe(1));\n';
const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function writeFixtureFile(directory: string, filePath: string, contents: string) {
  const absolutePath = join(directory, filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function writeSourceWithTest(directory: string, filePath: string, contents: string) {
  writeFixtureFile(directory, filePath, contents);
  writeFixtureFile(directory, `${filePath.slice(0, -".ts".length)}.test.ts`, passingTestSource);
}

function createRepositoryFixture() {
  const directory = mkdtempSync(join(tmpdir(), "prepare-mutation-shards-"));
  temporaryDirectories.push(directory);
  writeFixtureFile(directory, "README.md", "fixture\n");

  const git = (...argumentsToPass: string[]) =>
    execFileSync("git", argumentsToPass, { cwd: directory, encoding: "utf8" });
  git("init", "--initial-branch=main");
  git("config", "user.email", "mutation@example.test");
  git("config", "user.name", "Mutation Test");
  git("config", "commit.gpgsign", "false");

  const commitAll = (message: string) => {
    git("add", "--all");
    git("commit", "--message", message);
  };

  return { commitAll, directory };
}

function runShardPreparation(directory: string, argumentsToPass: string[]) {
  return spawnSync(
    resolve("node_modules/.bin/tsx"),
    [scriptPath, "--workspace", directory, ...argumentsToPass],
    { encoding: "utf8" },
  );
}

function shardsFor(directory: string, scope: string, diffRange = "HEAD~1...HEAD") {
  const result = runShardPreparation(directory, ["--scope", scope, "--diff-range", diffRange]);
  expect(result.status, result.stderr).toBe(0);
  return z.array(z.string()).parse(JSON.parse(result.stdout));
}

function filesInShards(shards: readonly string[]): string[] {
  return shards.flatMap((shard) => shard.split(","));
}

function weightOf(spec: string): number {
  const range = spec.slice(spec.lastIndexOf(":") + 1);
  const [start, end] = range.split("-").map(Number);
  return end - start + 1;
}

describe("prepare-mutation-shards", () => {
  it("partitions shared package sources from application sources", () => {
    const fixture = createRepositoryFixture();
    fixture.commitAll("base");

    writeSourceWithTest(
      fixture.directory,
      "packages/format/src/duration.ts",
      "export const duration = 1;\n",
    );
    writeSourceWithTest(fixture.directory, "src/worker.ts", "export const worker = 1;\n");
    fixture.commitAll("change shared and server sources");

    expect(shardsFor(fixture.directory, "shared")).toEqual(["packages/format/src/duration.ts:1-1"]);
    expect(shardsFor(fixture.directory, "server")).toEqual(["src/worker.ts:1-1"]);
  });

  it("preserves the existing discovery exclusions for both scopes", () => {
    const fixture = createRepositoryFixture();
    fixture.commitAll("base");

    for (const filePath of [
      "packages/format/src/generated.d.ts",
      "packages/format/src/generated.gen.ts",
      "packages/format/src/story.stories.ts",
      "packages/training/src/terminology.ts",
      "packages/server/src/routers/clickhouse-integration-test-models.ts",
      "src/db/drizzle-schema.ts",
      "src/db/schema/activities.ts",
      "scripts/migration-policy.ts",
      "cypress/e2e/onboarding.cy.ts",
      "packages/mobile/lib/format.ts",
      "packages/zepp/app.ts",
      "packages/zepp/setting/index.ts",
    ]) {
      writeSourceWithTest(fixture.directory, filePath, "export const value = 1;\n");
    }
    writeFixtureFile(
      fixture.directory,
      "packages/format/src/duration.config.ts",
      "export const value = 1;\n",
    );
    writeFixtureFile(
      fixture.directory,
      "packages/format/src/story.stories.tsx",
      "export const story = 1;\n",
    );
    fixture.commitAll("change excluded shared sources");

    expect(shardsFor(fixture.directory, "shared")).toEqual([]);
    expect(shardsFor(fixture.directory, "server")).toEqual([]);
  });

  it("skips files without colocated tests, runtime declarations, or changed lines", () => {
    const fixture = createRepositoryFixture();
    writeSourceWithTest(
      fixture.directory,
      "packages/format/src/deletion-only.ts",
      "// retained\nexport const value = 1;\n",
    );
    fixture.commitAll("base");

    writeFixtureFile(
      fixture.directory,
      "packages/format/src/no-colocated-test.ts",
      "export const value = 1;\n",
    );
    writeSourceWithTest(
      fixture.directory,
      "packages/format/src/types-only.ts",
      "export type Value = number;\n",
    );
    writeFixtureFile(fixture.directory, "packages/format/src/deletion-only.ts", "// retained\n");
    fixture.commitAll("change sources without mutable additions");

    expect(shardsFor(fixture.directory, "shared")).toEqual([]);
  });

  it("mutates only changed lines", () => {
    const fixture = createRepositoryFixture();
    writeSourceWithTest(
      fixture.directory,
      "packages/format/src/duration.ts",
      `${Array.from({ length: 10 }, (_, index) => `export const value${index} = ${index};`).join("\n")}\n`,
    );
    fixture.commitAll("base");

    const changedLines = Array.from(
      { length: 10 },
      (_, index) => `export const value${index} = ${index};`,
    );
    changedLines[4] = "export const value4 = 40;";
    changedLines.splice(5, 0, "export const addedA = 7;", "export const addedB = 8;");
    writeFixtureFile(
      fixture.directory,
      "packages/format/src/duration.ts",
      `${changedLines.join("\n")}\n`,
    );
    fixture.commitAll("change one range");

    expect(shardsFor(fixture.directory, "shared")).toEqual(["packages/format/src/duration.ts:5-7"]);
  });

  it("covers every selected file with 16 balanced shards", () => {
    const fixture = createRepositoryFixture();
    fixture.commitAll("base");

    const expectedSpecs: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const filePath = `packages/format/src/file-${index}.ts`;
      const lineCount = index + 1;
      writeSourceWithTest(
        fixture.directory,
        filePath,
        `${Array.from({ length: lineCount }, (_, line) => `export const value${index}_${line} = ${line};`).join("\n")}\n`,
      );
      expectedSpecs.push(`${filePath}:1-${lineCount}`);
    }
    fixture.commitAll("change twenty files");

    const shards = shardsFor(fixture.directory, "shared");
    expect(shards).toHaveLength(16);
    expect(filesInShards(shards).sort()).toEqual(expectedSpecs.sort());

    const shardWeights = shards.map((shard) =>
      shard.split(",").reduce((total, spec) => total + weightOf(spec), 0),
    );
    expect(Math.max(...shardWeights)).toBe(20);
  });

  it("fails for a missing diff range or unknown scope", () => {
    const fixture = createRepositoryFixture();
    fixture.commitAll("base");

    const missingRange = runShardPreparation(fixture.directory, ["--scope", "shared"]);
    expect(missingRange.status).not.toBe(0);
    expect(missingRange.stderr).toContain("--diff-range is required");

    const unknownScope = runShardPreparation(fixture.directory, [
      "--scope",
      "everywhere",
      "--diff-range",
      "HEAD...HEAD",
    ]);
    expect(unknownScope.status).not.toBe(0);
    expect(unknownScope.stderr).toContain("--scope must be shared or server");

    const unknownRevision = runShardPreparation(fixture.directory, [
      "--scope",
      "shared",
      "--diff-range",
      "missing-revision...HEAD",
    ]);
    expect(unknownRevision.status).not.toBe(0);
  });

  it("returns no shards when the diff is empty", () => {
    const fixture = createRepositoryFixture();
    fixture.commitAll("base");

    expect(shardsFor(fixture.directory, "shared", "HEAD...HEAD")).toEqual([]);
  });
});
