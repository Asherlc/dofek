import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./migrate.ts", () => ({ runMigrations: vi.fn() }));
vi.mock("./clickhouse.ts", () => ({
  createClickHouseClientFromEnv: vi.fn(),
}));
vi.mock("./clickhouse-migrations.ts", () => ({
  runClickHouseMigrations: vi.fn(),
}));
vi.mock("./sync-views.ts", () => ({
  syncMaterializedViews: vi.fn(),
}));
vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

import { logger } from "../logger.ts";
import { createClickHouseClientFromEnv } from "./clickhouse.ts";
import { runClickHouseMigrations } from "./clickhouse-migrations.ts";
import { runMigrations } from "./migrate.ts";
import { main } from "./run-migrate.ts";
import { syncMaterializedViews } from "./sync-views.ts";

const mockRunMigrations = vi.mocked(runMigrations);
const mockCreateClickHouseClientFromEnv = vi.mocked(createClickHouseClientFromEnv);
const mockRunClickHouseMigrations = vi.mocked(runClickHouseMigrations);
const mockSyncMaterializedViews = vi.mocked(syncMaterializedViews);
const mockLogger = vi.mocked(logger);

describe("run-migrate main()", () => {
  const originalUrl = process.env.DATABASE_URL;
  const originalClickHouseUrl = process.env.CLICKHOUSE_URL;
  const clickHouseClient = { command: vi.fn(), query: vi.fn(), close: vi.fn() };

  beforeEach(() => {
    mockRunMigrations.mockReset();
    mockCreateClickHouseClientFromEnv.mockReset();
    mockRunClickHouseMigrations.mockReset();
    mockSyncMaterializedViews.mockReset();
    clickHouseClient.command.mockReset();
    clickHouseClient.query.mockReset();
    clickHouseClient.close.mockReset();
    process.env.CLICKHOUSE_URL = "http://default:health@localhost:8123";
    mockCreateClickHouseClientFromEnv.mockReturnValue(clickHouseClient);
    mockRunClickHouseMigrations.mockResolvedValue(0);
    mockSyncMaterializedViews.mockResolvedValue({ synced: 0, skipped: 0, refreshed: 0 });
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
  });

  it("throws when DATABASE_URL is missing", async () => {
    delete process.env.DATABASE_URL;
    await expect(main()).rejects.toThrow("DATABASE_URL");
  });

  it("throws when CLICKHOUSE_URL is missing", async () => {
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    delete process.env.CLICKHOUSE_URL;
    await expect(main()).rejects.toThrow("CLICKHOUSE_URL");
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

    expect(mockRunClickHouseMigrations).toHaveBeenCalledWith(
      clickHouseClient,
      "postgres://test:test@localhost:5432/test",
    );
    expect(clickHouseClient.close).toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("1 ClickHouse migration(s) applied"),
    );
  });

  it("syncs Postgres materialized views before ClickHouse migrations", async () => {
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    mockRunMigrations.mockResolvedValue(0);
    mockSyncMaterializedViews.mockResolvedValue({ synced: 0, skipped: 6, refreshed: 1 });

    await main();

    expect(mockSyncMaterializedViews).toHaveBeenCalledWith(
      "postgres://test:test@localhost:5432/test",
    );
    expect(mockRunClickHouseMigrations.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockSyncMaterializedViews.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      "[migrate] Materialized views synced=0 skipped=6 refreshed=1",
    );
  });

  it("propagates errors from runMigrations", async () => {
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    mockRunMigrations.mockRejectedValue(new Error("connection refused"));

    await expect(main()).rejects.toThrow("connection refused");
  });
});
