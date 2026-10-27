import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { resolveComposeProjectIdentity } from "./compose-project.ts";

const workspaceDirectory = realpathSync(process.cwd());
const composeFilePath = join(workspaceDirectory, "docker-compose.yml");
const rawComposeArguments = process.argv.slice(2);
const unwrappedComposeArguments =
  rawComposeArguments[0] === "--" ? rawComposeArguments.slice(1) : rawComposeArguments;
const projectSuffixFlag = "--project-suffix";
const projectSuffixIndex = unwrappedComposeArguments.indexOf(projectSuffixFlag);
const { composeEnvironmentPath, composeProjectName } = resolveComposeProjectIdentity(
  workspaceDirectory,
  unwrappedComposeArguments,
);

const composeArguments =
  projectSuffixIndex === -1
    ? unwrappedComposeArguments
    : [
        ...unwrappedComposeArguments.slice(0, projectSuffixIndex),
        ...unwrappedComposeArguments.slice(projectSuffixIndex + 2),
      ];
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
