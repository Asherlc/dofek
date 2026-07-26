import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";

const workspaceDirectory = realpathSync(process.cwd());
const composeEnvironmentPath = join(workspaceDirectory, ".env.local");
const composeFilePath = join(workspaceDirectory, "docker-compose.yml");
const rawComposeArguments = process.argv.slice(2);
const unwrappedComposeArguments =
  rawComposeArguments[0] === "--" ? rawComposeArguments.slice(1) : rawComposeArguments;
const projectSuffixFlag = "--project-suffix";
const projectSuffixIndex = unwrappedComposeArguments.indexOf(projectSuffixFlag);
const projectSuffix =
  projectSuffixIndex === -1 ? null : unwrappedComposeArguments[projectSuffixIndex + 1];

if (projectSuffixIndex !== -1) {
  if (!projectSuffix || !/^[a-z0-9][a-z0-9_-]*$/.test(projectSuffix)) {
    throw new Error("--project-suffix requires a lowercase alphanumeric Compose name suffix");
  }
  if (unwrappedComposeArguments.indexOf(projectSuffixFlag, projectSuffixIndex + 1) !== -1) {
    throw new Error("--project-suffix can only be specified once");
  }
}

const composeArguments =
  projectSuffixIndex === -1
    ? unwrappedComposeArguments
    : [
        ...unwrappedComposeArguments.slice(0, projectSuffixIndex),
        ...unwrappedComposeArguments.slice(projectSuffixIndex + 2),
      ];
const baseComposeProjectName = basename(workspaceDirectory);
const composeProjectName =
  projectSuffix === null ? baseComposeProjectName : `${baseComposeProjectName}-${projectSuffix}`;
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

dockerArguments.push(...composeArguments);

const result = spawnSync("docker", dockerArguments, {
  cwd: workspaceDirectory,
  env: {
    ...process.env,
    COMPOSE_FILE: composeFilePath,
    COMPOSE_PROJECT_NAME: composeProjectName,
    PWD: workspaceDirectory,
  },
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
