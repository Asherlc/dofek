import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const fixtureDirectories: string[] = [];
const commandSchema = z.array(z.string());

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function createFixture(
  options: {
    codegraphInitialized?: boolean;
    dockerInfoFails?: boolean;
    nodeRequirement?: string;
    sandbox?: boolean;
  } = {},
) {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), "dev-environment-test-"));
  const binaryDirectory = join(fixtureDirectory, "bin");
  const commandLogPath = join(fixtureDirectory, "commands.jsonl");
  const vcpkgRoot = join(fixtureDirectory, "vcpkg");
  mkdirSync(binaryDirectory);
  mkdirSync(join(fixtureDirectory, ".codegraph"));
  mkdirSync(vcpkgRoot);
  writeFileSync(commandLogPath, "");
  fixtureDirectories.push(fixtureDirectory);

  if (options.codegraphInitialized) {
    writeFileSync(join(fixtureDirectory, ".codegraph", "codegraph.db"), "fixture");
  }

  writeFileSync(
    join(fixtureDirectory, "package.json"),
    JSON.stringify({
      engines: { node: options.nodeRequirement ?? ">=26" },
      packageManager: "pnpm@11.17.0+sha512.fixture",
    }),
  );

  const commandScript = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const command = process.env.FAKE_COMMAND_NAME;
const args = process.argv.slice(2);
appendFileSync(process.env.COMMAND_LOG_PATH, JSON.stringify([command, ...args]) + "\\n");

if (command === "docker" && args[0] === "info" && process.env.DOCKER_INFO_FAILS === "1") {
  process.stderr.write("Docker daemon unavailable\\n");
  process.exit(23);
}

if (command === "codegraph" && args[0] === "init") {
  mkdirSync(join(process.cwd(), ".codegraph"), { recursive: true });
  writeFileSync(join(process.cwd(), ".codegraph", "codegraph.db"), "indexed");
}

const versions = {
  node: "v26.5.0",
  pnpm: "11.17.0",
  python: "Python 3.12.13",
  uv: "uv 0.11.32",
  infisical: "infisical version 0.43.114",
  codegraph: "1.5.0",
  rtk: "rtk 0.44.0",
  cmake: "cmake version 4.4.0",
  ninja: "1.13.2",
  gh: "gh version 2.96.0",
  jq: "jq-1.8.2",
  docker: "Docker version 29.6.2",
  git: "git version 2.51.0",
  cc: "cc 18.1.8",
  "c++": "c++ 18.1.8",
};
process.stdout.write((versions[command] || "ok") + "\\n");
`;

  for (const command of [
    "node",
    "pnpm",
    "python",
    "uv",
    "infisical",
    "codegraph",
    "rtk",
    "cmake",
    "ninja",
    "gh",
    "jq",
    "docker",
    "git",
    "cc",
    "c++",
  ]) {
    const executablePath = join(binaryDirectory, command);
    writeExecutable(
      executablePath,
      `#!/bin/sh
FAKE_COMMAND_NAME=${command} exec "${process.execPath}" "${join(binaryDirectory, "command.cjs")}" "$@"
`,
    );
  }
  writeFileSync(join(binaryDirectory, "command.cjs"), commandScript);
  writeExecutable(
    join(vcpkgRoot, "vcpkg"),
    `#!/bin/sh
FAKE_COMMAND_NAME=vcpkg exec "${process.execPath}" "${join(binaryDirectory, "command.cjs")}" "$@"
`,
  );

  return { binaryDirectory, commandLogPath, fixtureDirectory, vcpkgRoot };
}

function runDevEnvironment(
  mode: string,
  options: {
    codegraphInitialized?: boolean;
    dockerInfoFails?: boolean;
    nodeRequirement?: string;
    sandbox?: boolean;
  } = {},
) {
  const fixture = createFixture(options);
  const result = spawnSync(
    process.execPath,
    [resolve("node_modules/tsx/dist/cli.mjs"), resolve("scripts/dev-environment.ts"), mode],
    {
      cwd: fixture.fixtureDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        COMMAND_LOG_PATH: fixture.commandLogPath,
        DOCKER_INFO_FAILS: options.dockerInfoFails ? "1" : "0",
        PATH: `${fixture.binaryDirectory}:${process.env.PATH ?? ""}`,
        SANDBOX: options.sandbox ? "1" : "0",
        VCPKG_ROOT: fixture.vcpkgRoot,
      },
    },
  );
  const commands = readFileSync(fixture.commandLogPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => commandSchema.parse(JSON.parse(line)));

  return { commands, fixture, result };
}

afterEach(() => {
  for (const fixtureDirectory of fixtureDirectories.splice(0)) {
    rmSync(fixtureDirectory, { force: true, recursive: true });
  }
});

describe("dev-environment", () => {
  it("initializes CodeGraph and verifies RTK after dependencies are installed", () => {
    const { commands, result } = runDevEnvironment("prebuild");

    expect(result.status).toBe(0);
    expect(commands).toEqual([
      ["codegraph", "init"],
      ["rtk", "--version"],
    ]);
  });

  it("keeps prebuild idempotent when the CodeGraph index already exists", () => {
    const { commands, result } = runDevEnvironment("prebuild", {
      codegraphInitialized: true,
    });

    expect(result.status).toBe(0);
    expect(commands).toEqual([["rtk", "--version"]]);
  });

  it("fails before starting services when the Docker daemon is unavailable", () => {
    const { commands, result } = runDevEnvironment("start", { dockerInfoFails: true });

    expect(result.status).toBe(23);
    expect(result.stderr).toContain("Docker daemon unavailable");
    expect(commands).toEqual([["docker", "info"]]);
  });

  it("skips service startup when SANDBOX=1 marks a Docker-less environment", () => {
    const { commands, result } = runDevEnvironment("start", { sandbox: true });

    expect(result.status).toBe(0);
    expect(commands).toEqual([]);
    expect(result.stdout).toContain("SANDBOX=1");
  });

  it("enforces the Node.js requirement declared by package.json", () => {
    const { commands, result } = runDevEnvironment("doctor", {
      codegraphInitialized: true,
      nodeRequirement: ">=27",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Node.js >=27 is required; found v26.5.0.");
    expect(commands).toEqual([["node", "--version"]]);
  });

  it("starts services, initializes databases, and verifies the complete environment", () => {
    const { commands, result } = runDevEnvironment("start", {
      codegraphInitialized: true,
    });

    expect(result.status).toBe(0);
    expect(commands.slice(0, 3)).toEqual([
      ["docker", "info"],
      ["pnpm", "compose:up"],
      ["pnpm", "setup-db"],
    ]);
    expect(commands).toContainEqual(["codegraph", "--version"]);
    expect(commands).toContainEqual(["rtk", "--version"]);
    expect(commands).toContainEqual(["docker", "compose", "version"]);
    expect(commands).toContainEqual(["git", "--version"]);
    expect(commands).toContainEqual(["cc", "--version"]);
    expect(commands).toContainEqual(["c++", "--version"]);
    expect(result.stdout).toContain("Development environment is ready.");
  });
});
