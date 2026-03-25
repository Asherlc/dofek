import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./migrate.ts", () => ({ runMigrations: vi.fn() }));
vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

import { logger } from "../logger.ts";
import { runMigrations } from "./migrate.ts";
import { main } from "./run-migrate.ts";

const mockRunMigrations = vi.mocked(runMigrations);
const mockLogger = vi.mocked(logger);

describe("run-migrate main()", () => {
  const originalUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    mockRunMigrations.mockReset();
  });

  afterEach(() => {
    if (originalUrl) {
      process.env.DATABASE_URL = originalUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  });

  it("throws when DATABASE_URL is missing", async () => {
    delete process.env.DATABASE_URL;
    await expect(main()).rejects.toThrow("DATABASE_URL");
  });

  it("runs migrations and logs the count", async () => {
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    mockRunMigrations.mockResolvedValue(3);

    await main();

    expect(mockRunMigrations).toHaveBeenCalledWith("postgres://test:test@localhost:5432/test");
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("3 migration(s) applied"));
  });

  it("propagates errors from runMigrations", async () => {
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    mockRunMigrations.mockRejectedValue(new Error("connection refused"));

    await expect(main()).rejects.toThrow("connection refused");
  });
});
