import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./migrate.ts", () => ({ runMigrations: vi.fn() }));
vi.mock("./clickhouse.ts", () => ({
  createClickHouseClientFromEnv: vi.fn(),
}));
vi.mock("./clickhouse-migrations.ts", () => ({
  runClickHouseMigrations: vi.fn(),
}));
vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

import { logger } from "../logger.ts";
import { createClickHouseClientFromEnv } from "./clickhouse.ts";
import { runClickHouseMigrations } from "./clickhouse-migrations.ts";
import { runMigrations } from "./migrate.ts";
import { main } from "./run-migrate.ts";

const mockRunMigrations = vi.mocked(runMigrations);
const mockCreateClickHouseClientFromEnv = vi.mocked(createClickHouseClientFromEnv);
const mockRunClickHouseMigrations = vi.mocked(runClickHouseMigrations);
const mockLogger = vi.mocked(logger);

describe("run-migrate main()", () => {
  const originalUrl = process.env.DATABASE_URL;
  const originalClickHouseUrl = process.env.CLICKHOUSE_URL;
  const originalArguments = [...process.argv];
  const clickHouseClient: {
    command: CallableVitestMock;
    query: CallableVitestMock;
    close?: CallableVitestMock;
  } = { command: vi.fn(), query: vi.fn(), close: vi.fn() };

  beforeEach(() => {
    mockRunMigrations.mockReset();
    mockCreateClickHouseClientFromEnv.mockReset();
    mockRunClickHouseMigrations.mockReset();
    clickHouseClient.command.mockReset();
    clickHouseClient.query.mockReset();
    clickHouseClient.close = vi.fn();
    process.env.CLICKHOUSE_URL = "http://default:health@localhost:8123";
    mockCreateClickHouseClientFromEnv.mockImplementation(() => {
      if (!process.env.CLICKHOUSE_URL) {
        throw new Error("CLICKHOUSE_URL is required");
      }
      return clickHouseClient;
    });
    mockRunClickHouseMigrations.mockResolvedValue(0);
  });

  afterEach(() => {
    if (originalUrl) {
      process.env.DATABASE_URL = originalUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
    if (originalClickHouseUrl) {
      process.env.CLICKHOUSE_URL = originalClickHouseUrl;
    } else {
      delete process.env.CLICKHOUSE_URL;
    }
    process.argv = originalArguments;
  });

  it("throws when DATABASE_URL is missing", async () => {
    delete process.env.DATABASE_URL;
    await expect(main()).rejects.toThrow("DATABASE_URL");
  });

  it("throws when CLICKHOUSE_URL is missing", async () => {
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    delete process.env.CLICKHOUSE_URL;
    await expect(main()).rejects.toThrow("CLICKHOUSE_URL");
    expect(mockRunMigrations).not.toHaveBeenCalled();
    expect(mockCreateClickHouseClientFromEnv).not.toHaveBeenCalled();
  });

  it("runs migrations and logs the count", async () => {
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    mockRunMigrations.mockResolvedValue(3);

    await main();

    expect(mockRunMigrations).toHaveBeenCalledWith("postgres://test:test@localhost:5432/test");
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("3 migration(s) applied"));
  });

  it("runs ClickHouse migrations when CLICKHOUSE_URL is configured", async () => {
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    mockRunMigrations.mockResolvedValue(3);
    mockRunClickHouseMigrations.mockResolvedValue(1);

    await main();

    expect(mockCreateClickHouseClientFromEnv).toHaveBeenCalledWith(process.env, {
      requestTimeoutMs: 3_300_000,
    });
    expect(mockRunClickHouseMigrations).toHaveBeenCalledWith(
      clickHouseClient,
      "postgres://test:test@localhost:5432/test",
    );
    expect(clickHouseClient.close).toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("ClickHouse migrations complete — 1 migration(s) applied"),
    );
  });

  it("does not require close() on the ClickHouse client", async () => {
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    clickHouseClient.close = undefined;
    mockRunMigrations.mockResolvedValue(1);
    mockCreateClickHouseClientFromEnv.mockReturnValue(clickHouseClient);

    await expect(main()).resolves.toBeUndefined();
    expect(mockRunClickHouseMigrations).toHaveBeenCalledWith(
      clickHouseClient,
      "postgres://test:test@localhost:5432/test",
    );
  });

  it("does not sync Postgres views during deploy migrations", async () => {
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    mockRunMigrations.mockResolvedValue(0);
    mockRunClickHouseMigrations.mockResolvedValue(2);

    await main();

    expect(mockRunMigrations).toHaveBeenCalledWith("postgres://test:test@localhost:5432/test");
    expect(mockRunClickHouseMigrations).toHaveBeenCalledWith(
      clickHouseClient,
      "postgres://test:test@localhost:5432/test",
    );
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("Materialized views synced"),
    );
  });

  it("propagates errors from runMigrations", async () => {
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    mockRunMigrations.mockRejectedValue(new Error("connection refused"));

    await expect(main()).rejects.toThrow("connection refused");
  });

  it("reports direct-run failures to nonzero exit code", async () => {
    process.argv = ["node", "run-migrate.ts"];
    const runMigrateScript = fileURLToPath(new URL("./run-migrate.ts", import.meta.url));

    const result = spawnSync("pnpm", ["tsx", runMigrateScript], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: "",
        CLICKHOUSE_URL: "",
        REDIS_URL: "redis://localhost:6379",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result.status).toBe(1);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(String(output)).toContain("[migrate] Error:");
  });
});
