import { execFileSync } from "node:child_process";

const composeFile = "docker-compose.e2e.yml";
const upOnlyFlag = "--up-only";
const reviewStackSpec = "cypress/e2e/review-stack.cy.ts";

function run(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: "inherit" });
}

function output(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function dockerCompose(args: string[]): void {
  run("pnpm", ["compose", "--", "--project-suffix", "e2e", "-f", composeFile, ...args]);
}

function dockerComposeOutput(args: string[]): string {
  return output("pnpm", [
    "--silent",
    "compose",
    "--",
    "--project-suffix",
    "e2e",
    "-f",
    composeFile,
    ...args,
  ]);
}

function runOneShotService(service: string, noDeps = false): void {
  dockerCompose(["up", "-d", "--no-build", ...(noDeps ? ["--no-deps"] : []), service]);
  const containerId = dockerComposeOutput(["ps", "--all", "-q", service]);
  if (!containerId) {
    throw new Error(`Could not find ${service} container after docker compose up`);
  }

  const exitCode = output("docker", ["wait", containerId]);
  if (exitCode !== "0") {
    throw new Error(`${service} exited with code ${exitCode}`);
  }
}

const cypressArgs = process.argv.slice(2).filter((arg) => arg !== upOnlyFlag && arg !== "--");
const upOnly = process.argv.includes(upOnlyFlag);
const isFocusedReviewStackRun = cypressArgs.includes(reviewStackSpec);

dockerCompose([
  "up",
  "-d",
  "--wait",
  "--no-build",
  "db",
  "clickhouse",
  "redis",
  "account-erasure-minio",
  "redpanda",
]);
runOneShotService("migrate");
if (isFocusedReviewStackRun) {
  runOneShotService("seed");
  runOneShotService("review-seed-clickhouse");
}
runOneShotService("analytics", true);
dockerCompose(["up", "-d", "--wait", "--no-build", "--no-deps", "server"]);

if (!upOnly) {
  run("pnpm", ["exec", "cypress", "run", ...cypressArgs]);
}
