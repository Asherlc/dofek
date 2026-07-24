import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { z } from "zod";

const infisicalExportSchema = z.array(
  z
    .object({
      key: z.string().min(1),
      value: z.string(),
    })
    .passthrough(),
);

function readEnvironmentFile(path: string): Record<string, string> {
  return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rawCommandArguments = process.argv.slice(2);
const commandArguments =
  rawCommandArguments[0] === "--" ? rawCommandArguments.slice(1) : rawCommandArguments;

if (commandArguments.length === 0) {
  console.error("Usage: with-env.ts <command>");
  process.exit(64);
}

const defaultEnvironment = readEnvironmentFile(resolve(repositoryRoot, ".env"));
const localEnvironment = readEnvironmentFile(resolve(repositoryRoot, ".env.local"));
const infisicalResult = spawnSync(
  "infisical",
  ["export", "--env=prod", "--format=json", "--silent"],
  {
    encoding: "utf8",
    env: {
      ...defaultEnvironment,
      ...process.env,
      ...localEnvironment,
    },
  },
);

if (infisicalResult.error || infisicalResult.status !== 0) {
  if (infisicalResult.stderr) {
    process.stderr.write(infisicalResult.stderr);
  }
  if (infisicalResult.error) {
    console.error(infisicalResult.error.message);
  }
  console.error("Failed to export secrets from Infisical");
  process.exit(infisicalResult.status ?? 1);
}

let infisicalEnvironment: Record<string, string>;
try {
  const exportedSecrets = infisicalExportSchema.parse(JSON.parse(infisicalResult.stdout));
  infisicalEnvironment = Object.fromEntries(exportedSecrets.map(({ key, value }) => [key, value]));
} catch (error: unknown) {
  console.error("Infisical returned an invalid JSON export");
  if (error instanceof Error) {
    console.error(error.message);
  }
  process.exit(1);
}

const commandEnvironment = {
  ...defaultEnvironment,
  ...process.env,
  ...infisicalEnvironment,
  ...localEnvironment,
  SENTRY_ENVIRONMENT:
    localEnvironment.SENTRY_ENVIRONMENT ?? process.env.SENTRY_ENVIRONMENT ?? "development",
};
const axiomApiToken = commandEnvironment.AXIOM_API_TOKEN;
if (axiomApiToken) {
  const authorizationHeaders = `Authorization=Bearer ${axiomApiToken},X-Axiom-Dataset=dofek-logs`;
  commandEnvironment.OTEL_EXPORTER_OTLP_HEADERS = authorizationHeaders;
  commandEnvironment.OTEL_EXPORTER_OTLP_LOGS_HEADERS = authorizationHeaders;
}

const commandResult = spawnSync(commandArguments[0], commandArguments.slice(1), {
  env: commandEnvironment,
  stdio: "inherit",
});
if (commandResult.error) {
  console.error(commandResult.error.message);
  process.exit(1);
}
if (commandResult.signal) {
  process.exit(128 + constants.signals[commandResult.signal]);
}
process.exit(commandResult.status ?? 1);
