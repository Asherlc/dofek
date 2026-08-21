import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const testModeSchema = z.enum(["all", "changed", "integration"]);
const testEnvironmentSchema = z.object({
  CLICKHOUSE_URL: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  REDPANDA_BROKERS: z.string().min(1),
  REDIS_URL: z.string().min(1),
});

function runCommand(command: string, commandArguments: string[], environment = process.env): void {
  const result = spawnSync(command, commandArguments, {
    cwd: process.cwd(),
    env: { ...environment, PWD: process.cwd() },
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
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

runCommand("pnpm", ["compose:up"]);

const localEnvironment = testEnvironmentSchema.parse(
  readDotenvFile(join(process.cwd(), ".env.local")),
);
const testEnvironment = {
  ...process.env,
  ...localEnvironment,
  TEST_DATABASE_URL: localEnvironment.DATABASE_URL,
};
const vitestArguments = ["exec", "vitest", "run"];

if (mode === "integration") {
  vitestArguments.push("--project", "integration");
} else if (mode === "changed") {
  vitestArguments.push("--changed", "origin/main");
}

vitestArguments.push(...additionalArguments);
runCommand("pnpm", vitestArguments, testEnvironment);
