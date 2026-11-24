import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { type ComposeContainerRow, listComposeContainers } from "./compose-container-inventory.ts";
import { resolveComposeProjectIdentity } from "./compose-project.ts";

const workspaceDirectory = realpathSync(process.cwd());
const workspaceProject = basename(workspaceDirectory);
const defaultComposeFiles = ["-f", "docker-compose.yml", "-f", "docker-compose.peerdb.yml"];
const shutdownOptions = ["--profile", "*", "down", "--remove-orphans", "--volumes"];
const standardProjectArguments = [
  defaultComposeFiles,
  ["--project-suffix", "e2e", "-f", "docker-compose.e2e.yml"],
  ["--project-suffix", "peerdb-integration", ...defaultComposeFiles],
];
const standardProjectNames = new Set([
  workspaceProject,
  `${workspaceProject}-e2e`,
  `${workspaceProject}-peerdb-integration`,
]);

function ownedContainers(rows: ComposeContainerRow[]): ComposeContainerRow[] {
  const owned = rows.filter((row) => row.directory === workspaceDirectory);
  const projects = new Set([...standardProjectNames, ...owned.map((row) => row.project)]);
  const conflict = rows.find(
    (row) => projects.has(row.project) && row.directory !== workspaceDirectory,
  );
  if (conflict?.directory === "") {
    throw new Error(
      `Compose project ${conflict.project} has containers with an empty working-directory label.`,
    );
  }
  if (conflict) {
    throw new Error(
      `Compose project ${conflict.project} is shared across directories: ${conflict.directory} and ${workspaceDirectory}`,
    );
  }
  return owned;
}

function customProjectArguments(owned: ComposeContainerRow[]): string[][] {
  const configLabels = new Map<string, string>();
  for (const { project, configFiles } of owned) {
    if (standardProjectNames.has(project)) {
      continue;
    }
    const recorded = configLabels.get(project);
    if (recorded !== undefined && recorded !== configFiles) {
      throw new Error(`Compose project ${project} has conflicting config file labels.`);
    }
    configLabels.set(project, configFiles);
  }
  const prefix = `${workspaceProject}-`;
  return [...configLabels].map(([project, configFiles]) => {
    if (!project.startsWith(prefix)) {
      throw new Error(`Compose project ${project} requires the workspace prefix ${prefix}.`);
    }
    const files = configFiles.split(",");
    if (files.some((file) => file.length === 0)) {
      throw new Error(`Compose project ${project} is missing recorded config files.`);
    }
    const suffixArguments = ["--project-suffix", project.slice(prefix.length)];
    resolveComposeProjectIdentity(workspaceDirectory, suffixArguments);
    return [...suffixArguments, ...files.flatMap((file) => ["-f", file])];
  });
}

function runShutdown(projectArguments: string[]): void {
  const arguments_ = ["compose", "--", ...projectArguments, ...shutdownOptions];
  const result = spawnSync("pnpm", arguments_, {
    cwd: workspaceDirectory,
    env: { ...process.env, PWD: workspaceDirectory },
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const failure = result.signal
      ? `signal ${result.signal}`
      : `status ${result.status ?? "unknown"}`;
    throw new Error(`pnpm ${arguments_.join(" ")} exited with ${failure}`);
  }
}

const additionalProjectArguments = customProjectArguments(ownedContainers(listComposeContainers()));

for (const projectArguments of [...standardProjectArguments, ...additionalProjectArguments]) {
  runShutdown(projectArguments);
}

const remainingOwned = ownedContainers(listComposeContainers());
if (remainingOwned.length > 0) {
  const projectNames = [...new Set(remainingOwned.map((row) => row.project))].sort();
  const containerNames = remainingOwned.map((row) => row.name).sort();
  throw new Error(
    `Workspace archive left owned Compose containers: projects ${projectNames.join(", ")}; containers ${containerNames.join(", ")}`,
  );
}
