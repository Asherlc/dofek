import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const testModeSchema = z.enum(["all", "changed", "integration", "peerdb-integration"]);
const testEnvironmentSchema = z.object({
  CLICKHOUSE_URL: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  REDPANDA_BROKERS: z.string().min(1),
  REDIS_URL: z.string().min(1),
});

function runCommand(
  command: string,
  commandArguments: string[],
  environment = process.env,
): number {
  const result = spawnSync(command, commandArguments, {
    cwd: process.cwd(),
    env: { ...environment, PWD: process.cwd() },
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

function readDotenvFile(path: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) {
      entries[match[1]] = match[2];
    }
  }
  return entries;
}

const [modeValue, ...rawAdditionalArguments] = process.argv.slice(2);
const mode = testModeSchema.parse(modeValue);
const additionalArguments =
  rawAdditionalArguments[0] === "--" ? rawAdditionalArguments.slice(1) : rawAdditionalArguments;

const composeExitCode = runCommand("pnpm", ["compose:up"]);
if (composeExitCode !== 0) process.exit(composeExitCode);

const localEnvironment = testEnvironmentSchema.parse(
  readDotenvFile(join(process.cwd(), ".env.local")),
);
const testEnvironment = {
  ...process.env,
  ...localEnvironment,
  TEST_DATABASE_URL: localEnvironment.DATABASE_URL,
};
const vitestArguments = ["exec", "vitest", "run"];
const ordinaryTestProjects = ["unit", "mobile", "integration"];

if (mode === "integration") {
  vitestArguments.push("--project", "integration");
} else if (mode === "peerdb-integration") {
  vitestArguments.push("--project", "peerdb-integration");
} else {
  for (const project of ordinaryTestProjects) {
    vitestArguments.push("--project", project);
  }
  if (mode === "changed") {
    vitestArguments.push("--changed", "origin/main");
  }
}

vitestArguments.push(...additionalArguments);

const peerDbComposeArguments = [
  "compose",
  "--",
  "-f",
  "docker-compose.yml",
  "-f",
  "docker-compose.peerdb.yml",
];

if (mode !== "peerdb-integration") {
  process.exit(runCommand("pnpm", vitestArguments, testEnvironment));
}

let exitCode = 1;
try {
  exitCode = runCommand("pnpm", [
    ...peerDbComposeArguments,
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "180",
  ]);
  if (exitCode === 0) {
    exitCode = runCommand("pnpm", vitestArguments, testEnvironment);
  }
} finally {
  const cleanupExitCode = runCommand("pnpm", [
    ...peerDbComposeArguments,
    "down",
    "--remove-orphans",
    "--volumes",
  ]);
  if (exitCode === 0 && cleanupExitCode !== 0) exitCode = cleanupExitCode;
}
process.exit(exitCode);
