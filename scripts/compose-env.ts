import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

interface ComposeServicePort {
  service: string;
  privatePort: string;
}

function composePort(input: ComposeServicePort): string {
  const output = execFileSync("docker", ["compose", "port", input.service, input.privatePort], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const match = output.match(/:(\d+)$/);
  if (!match) {
    throw new Error(`Could not parse docker compose port output for ${input.service}: ${output}`);
  }
  return match[1];
}

function tryComposePort(input: ComposeServicePort): string | undefined {
  try {
    return composePort(input);
  } catch {
    return undefined;
  }
}

function dotenvEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}

function readDotenv(path: string): Record<string, string> {
  if (!existsSync(path)) {
    return {};
  }

  const entries: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) {
      entries[match[1]] = match[2];
    }
  }
  return entries;
}

async function findFreePort(): Promise<string> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a local port")));
        return;
      }
      server.close(() => resolve(String(address.port)));
    });
  });
}

async function resolvePort(input: {
  env: Record<string, string | undefined>;
  key: string;
  service: string;
  privatePort: string;
}): Promise<string> {
  return (
    tryComposePort({ service: input.service, privatePort: input.privatePort }) ??
    input.env[input.key] ??
    (await findFreePort())
  );
}

const postgresPassword = process.env.POSTGRES_PASSWORD ?? "health";
const clickHousePassword = process.env.CLICKHOUSE_PASSWORD ?? "health";
const postgresPasswordUrlEncoded = encodeURIComponent(postgresPassword);
const clickHousePasswordUrlEncoded = encodeURIComponent(clickHousePassword);
const existingEnv = {
  ...readDotenv(join(process.cwd(), ".env.local")),
  ...process.env,
};
const databasePort = await resolvePort({
  env: existingEnv,
  key: "POSTGRES_PORT",
  service: "db",
  privatePort: "5432",
});
const clickHouseHttpPort = await resolvePort({
  env: existingEnv,
  key: "CLICKHOUSE_HTTP_PORT",
  service: "clickhouse",
  privatePort: "8123",
});
const clickHouseNativePort = await resolvePort({
  env: existingEnv,
  key: "CLICKHOUSE_NATIVE_PORT",
  service: "clickhouse",
  privatePort: "9000",
});
const redisPort = await resolvePort({
  env: existingEnv,
  key: "REDIS_PORT",
  service: "redis",
  privatePort: "6379",
});

const dotenv = [
  `POSTGRES_PASSWORD=${dotenvEscape(postgresPassword)}`,
  `CLICKHOUSE_PASSWORD=${dotenvEscape(clickHousePassword)}`,
  `POSTGRES_PORT=${databasePort}`,
  `CLICKHOUSE_HTTP_PORT=${clickHouseHttpPort}`,
  `CLICKHOUSE_NATIVE_PORT=${clickHouseNativePort}`,
  `REDIS_PORT=${redisPort}`,
  `DATABASE_URL=postgres://health:${postgresPasswordUrlEncoded}@127.0.0.1:${databasePort}/health`,
  `CLICKHOUSE_URL=http://default:${clickHousePasswordUrlEncoded}@127.0.0.1:${clickHouseHttpPort}`,
  `REDIS_URL=redis://127.0.0.1:${redisPort}`,
  "",
].join("\n");

if (process.argv.includes("--write")) {
  writeFileSync(join(process.cwd(), ".env.local"), dotenv);
} else {
  process.stdout.write(dotenv);
}
