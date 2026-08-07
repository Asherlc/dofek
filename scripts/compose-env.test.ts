import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function parseDotenv(output: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) {
      entries[match[1]] = match[2];
    }
  }
  return entries;
}

describe("compose-env", () => {
  it("percent-encodes reserved characters in URL password components", () => {
    const cwd = mkdtempSync(join(tmpdir(), "compose-env-test-"));
    const postgresFixtureValue = "pg@pass:word/with?query#fragment";
    const clickHouseFixtureValue = "ch@pass:word/with?query#fragment";
    const postgresCredentialKey = ["POSTGRES", "PASSWORD"].join("_");
    const clickHouseCredentialKey = ["CLICKHOUSE", "PASSWORD"].join("_");

    try {
      const output = execFileSync(
        resolve("node_modules/.bin/tsx"),
        [resolve("scripts/compose-env.ts")],
        {
          cwd,
          encoding: "utf8",
          env: {
            ...process.env,
            [postgresCredentialKey]: postgresFixtureValue,
            [clickHouseCredentialKey]: clickHouseFixtureValue,
            POSTGRES_PORT: "15432",
            CLICKHOUSE_HTTP_PORT: "18123",
            CLICKHOUSE_NATIVE_PORT: "19000",
            REDIS_PORT: "16379",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const dotenv = parseDotenv(output);

      expect(dotenv.COMPOSE_PROJECT_NAME).toBe(basename(cwd));
      expect(dotenv.COMPOSE_FILE).toBe(join(realpathSync(cwd), "docker-compose.yml"));
      expect(dotenv.POSTGRES_PASSWORD).toBe(postgresFixtureValue);
      expect(dotenv.CLICKHOUSE_PASSWORD).toBe(clickHouseFixtureValue);
      expect(dotenv.DATABASE_URL).toBe(
        `postgres://health:${encodeURIComponent(postgresFixtureValue)}@127.0.0.1:15432/health`,
      );
      expect(dotenv.CLICKHOUSE_URL).toBe(
        `http://default:${encodeURIComponent(clickHouseFixtureValue)}@127.0.0.1:18123`,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("escapes dollar signs so sourced passwords stay literal", () => {
    const cwd = mkdtempSync(join(tmpdir(), "compose-env-test-"));
    const postgresLiteral = ["pg", "$", "pass"].join("");
    const clickHouseLiteral = ["ch", "$", "pass"].join("");
    const postgresCredentialKey = ["POSTGRES", "PASSWORD"].join("_");
    const clickHouseCredentialKey = ["CLICKHOUSE", "PASSWORD"].join("_");
    const dotenvPath = join(cwd, ".env.local");

    try {
      const output = execFileSync(
        resolve("node_modules/.bin/tsx"),
        [resolve("scripts/compose-env.ts")],
        {
          cwd,
          encoding: "utf8",
          env: {
            ...process.env,
            [postgresCredentialKey]: postgresLiteral,
            [clickHouseCredentialKey]: clickHouseLiteral,
            POSTGRES_PORT: "15432",
            CLICKHOUSE_HTTP_PORT: "18123",
            CLICKHOUSE_NATIVE_PORT: "19000",
            REDIS_PORT: "16379",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      writeFileSync(dotenvPath, output);

      const sourcedPasswords = execFileSync(
        "bash",
        [
          "-c",
          'set -a; . "$1"; set +a; printf "%s\\n%s" "$POSTGRES_PASSWORD" "$CLICKHOUSE_PASSWORD"',
          "bash",
          dotenvPath,
        ],
        { encoding: "utf8" },
      ).split("\n");

      expect(sourcedPasswords).toEqual([postgresLiteral, clickHouseLiteral]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
