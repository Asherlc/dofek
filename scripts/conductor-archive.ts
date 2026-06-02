import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function runDocker(dockerArguments: string[]): string {
  const result = spawnSync("docker", dockerArguments, {
    encoding: "utf8",
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
  const output = runDocker(["compose", "config", "--format", "json"]);
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
  if (composeFile !== null && !existsSync(composeFile)) {
    return;
  }

  const dockerArguments = ["compose"];

  if (composeFile !== null) {
    dockerArguments.push("-f", composeFile);
  }

  dockerArguments.push("down", "--remove-orphans");
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
