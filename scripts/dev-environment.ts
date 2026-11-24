import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { captureException } from "../src/lib/error-reporting.ts";
import { listComposeContainers } from "./compose-container-inventory.ts";

interface ToolCheck {
  arguments_: string[];
  command: string;
  label: string;
}

const usage = "Usage: dev-environment.ts <prebuild|start|doctor>";
const environmentModeSchema = z.enum(["doctor", "prebuild", "start"]);
const paseoWorkspacesSchema = z.array(z.object({ cwd: z.string().min(1) }));
const packageManifestSchema = z.object({
  engines: z.object({
    node: z.string().min(1),
  }),
  packageManager: z.string().min(1),
});

function fail(message: string, status = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(status);
}

function runCommand(command: string, arguments_: string[]): void {
  const result = spawnSync(command, arguments_, {
    cwd: process.cwd(),
    env: { ...process.env, PWD: process.cwd() },
    stdio: "inherit",
  });

  if (result.error) {
    fail(`Unable to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function checkCommand({ arguments_, command, label }: ToolCheck): string {
  const result = spawnSync(command, arguments_, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, PWD: process.cwd() },
  });

  if (result.error) {
    fail(`${label} is unavailable: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    fail(`${label} check failed: ${command} ${arguments_.join(" ")}`, result.status ?? 1);
  }

  const version = result.stdout.trim().split("\n")[0];
  if (!version) {
    fail(`${label} returned no version information.`);
  }
  process.stdout.write(`✓ ${label}: ${version}\n`);
  return version;
}

function readPackageManifest(): z.infer<typeof packageManifestSchema> {
  const manifestPath = join(process.cwd(), "package.json");
  if (!existsSync(manifestPath)) {
    fail(`Missing required repository manifest: ${manifestPath}`);
  }
  return packageManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
}

function parseMinimumNodeMajor(requirement: string): number {
  const majorText = /^>=(\d+)$/.exec(requirement)?.[1];
  if (!majorText) {
    fail(
      `package.json engines.node must use the supported >=<major> format; found ${requirement}.`,
    );
  }
  return Number.parseInt(majorText, 10);
}

function prebuild(): void {
  const codegraphDatabase = join(process.cwd(), ".codegraph", "codegraph.db");
  if (!existsSync(codegraphDatabase)) {
    runCommand("codegraph", ["init"]);
  }

  runCommand("rtk", ["--version"]);
}

function doctor(): void {
  const manifest = readPackageManifest();
  const nodeRequirement = manifest.engines.node;
  const minimumNodeMajor = parseMinimumNodeMajor(nodeRequirement);

  const packageManager = manifest.packageManager.split("+")[0];
  const expectedPnpmVersion = packageManager?.match(/^pnpm@(.+)$/)?.[1];
  if (!expectedPnpmVersion) {
    fail("package.json must declare an exact pnpm packageManager version.");
  }

  const nodeVersion = checkCommand({
    arguments_: ["--version"],
    command: "node",
    label: "Node.js",
  });
  const nodeMajor = Number.parseInt(nodeVersion.replace(/^v/, "").split(".")[0] ?? "", 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < minimumNodeMajor) {
    fail(`Node.js ${nodeRequirement} is required; found ${nodeVersion}.`);
  }

  const pnpmVersion = checkCommand({
    arguments_: ["--version"],
    command: "pnpm",
    label: "pnpm",
  });
  if (pnpmVersion !== expectedPnpmVersion) {
    fail(`pnpm ${expectedPnpmVersion} is required; found ${pnpmVersion}.`);
  }

  const toolChecks: ToolCheck[] = [
    { arguments_: ["--version"], command: "python", label: "Python" },
    { arguments_: ["--version"], command: "uv", label: "uv" },
    { arguments_: ["--version"], command: "infisical", label: "Infisical CLI" },
    { arguments_: ["--version"], command: "codegraph", label: "CodeGraph" },
    { arguments_: ["--version"], command: "rtk", label: "RTK" },
    { arguments_: ["--version"], command: "git", label: "Git" },
    { arguments_: ["--version"], command: "cc", label: "C compiler" },
    { arguments_: ["--version"], command: "c++", label: "C++ compiler" },
    { arguments_: ["--version"], command: "cmake", label: "CMake" },
    { arguments_: ["--version"], command: "ninja", label: "Ninja" },
    { arguments_: ["--version"], command: "gh", label: "GitHub CLI" },
    { arguments_: ["--version"], command: "jq", label: "jq" },
    { arguments_: ["--version"], command: "docker", label: "Docker" },
    { arguments_: ["compose", "version"], command: "docker", label: "Docker Compose" },
  ];
  for (const toolCheck of toolChecks) {
    checkCommand(toolCheck);
  }

  const codegraphDatabase = join(process.cwd(), ".codegraph", "codegraph.db");
  if (!existsSync(codegraphDatabase)) {
    fail("CodeGraph is not initialized. Run `mise run cloud:prebuild`.");
  }

  const vcpkgRoot = process.env.VCPKG_ROOT;
  if (!vcpkgRoot) {
    fail("VCPKG_ROOT is required for the native FIT decoder.");
  }
  checkCommand({
    arguments_: ["version"],
    command: join(vcpkgRoot, "vcpkg"),
    label: "vcpkg",
  });

  checkPaseoComposeOrphans();

  process.stdout.write("Development environment is ready.\n");
}

function checkPaseoComposeOrphans(): void {
  const repositoryWorktrees = dirname(realpathSync(process.cwd()));
  const paseoWorktrees = join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "worktrees");
  if (
    !existsSync(paseoWorktrees) ||
    dirname(repositoryWorktrees) !== realpathSync(paseoWorktrees)
  ) {
    return;
  }

  try {
    const result = spawnSync("paseo", ["workspace", "ls", "--background", "--json"], {
      encoding: "utf8",
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(
        `paseo workspace ls failed: ${result.stderr.trim() || result.signal || result.status}`,
      );
    }
    const workspaces = paseoWorkspacesSchema.parse(JSON.parse(result.stdout));
    const activeDirectories = new Set(
      workspaces.map(({ cwd }) => (existsSync(cwd) ? realpathSync(cwd) : cwd)),
    );
    const staleProjects = new Set<string>();
    for (const { project, directory } of listComposeContainers()) {
      if (dirname(directory) === repositoryWorktrees && !activeDirectories.has(directory)) {
        staleProjects.add(`${project} (${directory})`);
      }
    }
    if (staleProjects.size === 0) {
      process.stdout.write("✓ Paseo Compose orphan check: no stale workspace containers.\n");
      return;
    }
    process.stderr.write(
      `Warning: Stale Compose projects from inactive Paseo workspaces:\n${[...staleProjects].sort().join("\n")}\n`,
    );
  } catch (error) {
    captureException(new Error("Paseo Compose inventory check failed"), {
      tags: { source: "dev-environment-doctor" },
    });
    process.stderr.write(
      `Warning: Could not check for stale Paseo Compose projects: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

function start(): void {
  if (process.env.SANDBOX === "1") {
    process.stdout.write("SANDBOX=1: skipping Docker-backed services.\n");
    return;
  }

  runCommand("docker", ["info"]);
  runCommand("pnpm", ["compose:up"]);
  runCommand("pnpm", ["setup-db"]);
  doctor();
}

const modeResult = environmentModeSchema.safeParse(process.argv[2]);
if (!modeResult.success) {
  fail(usage);
}
const mode = modeResult.data;

switch (mode) {
  case "doctor":
    doctor();
    break;
  case "prebuild":
    prebuild();
    break;
  case "start":
    start();
    break;
}
