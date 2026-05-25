import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    const postgresPassword = "pg@pass:word/with?query#fragment";
    const clickHousePassword = "ch@pass:word/with?query#fragment";

    try {
      const output = execFileSync(
        resolve("node_modules/.bin/tsx"),
        [resolve("scripts/compose-env.ts")],
        {
          cwd,
          encoding: "utf8",
          env: {
            ...process.env,
            POSTGRES_PASSWORD: postgresPassword,
            CLICKHOUSE_PASSWORD: clickHousePassword,
            POSTGRES_PORT: "15432",
            CLICKHOUSE_HTTP_PORT: "18123",
            CLICKHOUSE_NATIVE_PORT: "19000",
            REDIS_PORT: "16379",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const dotenv = parseDotenv(output);

      expect(dotenv.POSTGRES_PASSWORD).toBe(postgresPassword);
      expect(dotenv.CLICKHOUSE_PASSWORD).toBe(clickHousePassword);
      expect(dotenv.DATABASE_URL).toBe(
        `postgres://health:${encodeURIComponent(postgresPassword)}@127.0.0.1:15432/health`,
      );
      expect(dotenv.CLICKHOUSE_URL).toBe(
        `http://default:${encodeURIComponent(clickHousePassword)}@127.0.0.1:18123`,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
