import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

interface FixtureOptions {
  codegraphInitialized?: boolean;
  composeInventory?: Array<{
    configFiles?: string;
    directory: string;
    name: string;
    project: string;
  }>;
  composeInventoryFails?: boolean;
  dockerInfoFails?: boolean;
  managedPaseo?: boolean;
  nodeRequirement?: string;
  paseoWorkspaces?: Array<{ cwd: string }> | false;
  sandbox?: boolean;
}

function createFixture(options: FixtureOptions) {
  const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "dev-environment-test-")));
  const paseoHome = join(fixtureRoot, ".paseo");
  const fixtureDirectory = options.managedPaseo
    ? join(paseoHome, "worktrees", "dofek", "current")
    : fixtureRoot;
  mkdirSync(fixtureDirectory, { recursive: true });
  const binaryDirectory = join(fixtureDirectory, "bin");
  const commandLogPath = join(fixtureDirectory, "commands.jsonl");
  const vcpkgRoot = join(fixtureDirectory, "vcpkg");
  mkdirSync(binaryDirectory);
  mkdirSync(join(fixtureDirectory, ".codegraph"));
  mkdirSync(vcpkgRoot);
  writeFileSync(commandLogPath, "");
  fixtureDirectories.push(fixtureRoot);

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
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const command = process.env.FAKE_COMMAND_NAME;
const args = process.argv.slice(2);
appendFileSync(process.env.COMMAND_LOG_PATH, JSON.stringify([command, ...args]) + "\\n");

if (command === "docker" && args[0] === "info" && process.env.DOCKER_INFO_FAILS === "1") {
  process.stderr.write("Docker daemon unavailable\\n");
  process.exit(23);
}

if (command === "docker" && args[0] === "ps") {
  if (process.env.COMPOSE_INVENTORY_FAILS === "1") {
    process.stderr.write("Cannot connect to the Docker daemon\\n");
    process.exit(1);
  }
  const inventoryPath = process.env.COMPOSE_INVENTORY_PATH;
  if (inventoryPath) {
    process.stdout.write(readFileSync(inventoryPath, "utf8"));
    process.exit(0);
  }
}

if (command === "paseo" && args[0] === "workspace" && args[1] === "ls") {
  const workspacesPath = process.env.PASEO_WORKSPACES_PATH;
  if (!workspacesPath) {
    process.stderr.write("paseo daemon unavailable\\n");
    process.exit(1);
  }
  process.stdout.write(readFileSync(workspacesPath, "utf8"));
  process.exit(0);
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
  paseo: "paseo 0.0.0",
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
    "paseo",
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

  const composeInventoryPath = join(fixtureDirectory, "compose-inventory.jsonl");
  writeFileSync(
    composeInventoryPath,
    (options.composeInventory ?? [])
      .map((row) =>
        JSON.stringify({
          configFiles: row.configFiles ?? "",
          directory: resolve(fixtureDirectory, row.directory),
          name: row.name,
          project: row.project,
        }),
      )
      .join("\n"),
  );

  const paseoWorkspacesPath = join(fixtureDirectory, "paseo-workspaces.json");
  if (options.paseoWorkspaces !== false) {
    writeFileSync(
      paseoWorkspacesPath,
      JSON.stringify(
        (options.paseoWorkspaces ?? [{ cwd: "." }]).map(({ cwd }) => ({
          cwd: resolve(fixtureDirectory, cwd),
        })),
      ),
    );
  }

  return {
    binaryDirectory,
    commandLogPath,
    composeInventoryPath,
    fixtureDirectory,
    paseoHome,
    paseoWorkspacesPath: options.paseoWorkspaces === false ? undefined : paseoWorkspacesPath,
    vcpkgRoot,
  };
}

function runDevEnvironment(mode: string, options: FixtureOptions = {}) {
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
        COMPOSE_INVENTORY_FAILS: options.composeInventoryFails ? "1" : "0",
        COMPOSE_INVENTORY_PATH: fixture.composeInventoryPath,
        DOCKER_INFO_FAILS: options.dockerInfoFails ? "1" : "0",
        PASEO_HOME: fixture.paseoHome,
        PASEO_WORKSPACES_PATH: fixture.paseoWorkspacesPath,
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

  it("leaves the Paseo audit out of non-Paseo checkouts", () => {
    const { commands, result } = runDevEnvironment("doctor", {
      codegraphInitialized: true,
    });

    expect(result.status).toBe(0);
    expect(commands.some(([command]) => command === "paseo")).toBe(false);
    expect(result.stdout).toContain("Development environment is ready.");
  });

  it("passes the Compose orphan check when inventory directories match active workspaces", () => {
    const { commands, result } = runDevEnvironment("doctor", {
      codegraphInitialized: true,
      managedPaseo: true,
      composeInventory: [
        {
          name: "active-db-1",
          project: "active",
          directory: ".",
        },
        { name: "background-db-1", project: "background", directory: "../background" },
        { name: "other-db-1", project: "other-repo", directory: "../../other/repo" },
      ],
      paseoWorkspaces: [{ cwd: "." }, { cwd: "../background" }],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("no stale workspace containers");
    expect(commands).toContainEqual(["paseo", "workspace", "ls", "--background", "--json"]);
  });

  it("reports stale Compose projects from inactive Paseo workspaces", () => {
    const { fixture, result } = runDevEnvironment("doctor", {
      codegraphInitialized: true,
      managedPaseo: true,
      composeInventory: [
        {
          name: "archived-db-1",
          project: "archived-workspace",
          directory: "../archived-workspace",
        },
      ],
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/Stale Compose projects.*archived-workspace/s);
    expect(result.stderr).toContain(resolve(fixture.fixtureDirectory, "../archived-workspace"));
  });

  it("surfaces Compose inventory failures during the orphan check", () => {
    const { result } = runDevEnvironment("doctor", {
      codegraphInitialized: true,
      composeInventoryFails: true,
      managedPaseo: true,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Cannot connect to the Docker daemon");
    expect(result.stdout).not.toContain("no stale workspace containers");
  });

  it("warns when the Paseo workspace inventory is unavailable", () => {
    const { result } = runDevEnvironment("doctor", {
      codegraphInitialized: true,
      managedPaseo: true,
      paseoWorkspaces: false,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("paseo daemon unavailable");
    expect(result.stdout).not.toContain("no stale workspace containers");
  });
});
