import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";

const workspaceDirectory = realpathSync(process.cwd());
const composeEnvironmentPath = join(workspaceDirectory, ".env.local");
const composeFilePath = join(workspaceDirectory, "docker-compose.yml");
const composeProjectName = basename(workspaceDirectory);
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

const rawComposeArguments = process.argv.slice(2);
const composeArguments =
  rawComposeArguments[0] === "--" ? rawComposeArguments.slice(1) : rawComposeArguments;
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
