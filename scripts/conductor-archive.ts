import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";

const workspaceDirectory = realpathSync(process.cwd());
const composeEnvironmentPath = join(workspaceDirectory, ".env.local");
const composeFilePath = join(workspaceDirectory, "docker-compose.yml");
const composeProjectName = basename(workspaceDirectory);

function runDocker(dockerArguments: string[]): string {
  const result = spawnSync("docker", dockerArguments, {
    cwd: workspaceDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      COMPOSE_FILE: composeFilePath,
      COMPOSE_PROJECT_NAME: composeProjectName,
      PWD: workspaceDirectory,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `docker ${dockerArguments.join(" ")} exited with status ${result.status ?? "unknown"}`,
    );
  }

  return result.stdout.trim();
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null;
}

function getComposeProjectName(): string {
  const dockerArguments = [
    "compose",
    "--project-name",
    composeProjectName,
    "--project-directory",
    workspaceDirectory,
    "--file",
    composeFilePath,
  ];
  if (existsSync(composeEnvironmentPath)) {
    dockerArguments.push("--env-file", composeEnvironmentPath);
  }
  dockerArguments.push("config", "--format", "json");
  const output = runDocker(dockerArguments);
  const parsedConfig: unknown = JSON.parse(output);

  if (
    !isRecord(parsedConfig) ||
    typeof parsedConfig.name !== "string" ||
    parsedConfig.name.length === 0
  ) {
    throw new Error("Could not determine Docker Compose project name for this workspace");
  }

  return parsedConfig.name;
}

function runComposeDown(composeFile: string | null): void {
  const selectedComposeFile =
    composeFile === null ? composeFilePath : join(workspaceDirectory, composeFile);
  if (!existsSync(selectedComposeFile)) {
    return;
  }

  const dockerArguments = [
    "compose",
    "--project-name",
    composeProjectName,
    "--project-directory",
    workspaceDirectory,
  ];

  if (existsSync(composeEnvironmentPath)) {
    dockerArguments.push("--env-file", composeEnvironmentPath);
  }

  dockerArguments.push("--file", selectedComposeFile);
  dockerArguments.push("down", "--remove-orphans", "--volumes");
  runDocker(dockerArguments);
}

function removeProjectContainers(projectName: string): void {
  const containerIds = runDocker([
    "container",
    "ls",
    "--all",
    "--quiet",
    "--filter",
    `label=com.docker.compose.project=${projectName}`,
  ])
    .split("\n")
    .map((containerId) => containerId.trim())
    .filter((containerId) => containerId.length > 0);

  if (containerIds.length === 0) {
    return;
  }

  runDocker(["container", "rm", "--force", ...containerIds]);
}

const projectName = getComposeProjectName();

runComposeDown(null);
runComposeDown("docker-compose.e2e.yml");
removeProjectContainers(projectName);

console.log(`Removed Docker containers for Compose project ${projectName}`);
