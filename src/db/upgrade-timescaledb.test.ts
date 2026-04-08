import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSqlEnd = vi.fn().mockResolvedValue(undefined);
const mockSqlTagged = vi.fn();
const mockSql = Object.assign(mockSqlTagged, { end: mockSqlEnd });

vi.mock("postgres", () => ({
  default: vi.fn(() => mockSql),
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import { logger } from "../logger.ts";
import { upgradeTimescaleDb } from "./upgrade-timescaledb.ts";

describe("upgradeTimescaleDb", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("upgrades when installed version differs from available", async () => {
    mockSqlTagged
      .mockResolvedValueOnce([{ extversion: "2.26.1" }]) // before
      .mockResolvedValueOnce(undefined) // ALTER EXTENSION
      .mockResolvedValueOnce([{ extversion: "2.26.2" }]); // after

    await upgradeTimescaleDb("postgres://localhost/test");

    expect(mockSqlTagged).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith("[timescaledb] Upgraded extension: 2.26.1 → 2.26.2");
  });

  it("logs no-op when already at latest version", async () => {
    mockSqlTagged
      .mockResolvedValueOnce([{ extversion: "2.26.2" }]) // before
      .mockResolvedValueOnce(undefined) // ALTER EXTENSION
      .mockResolvedValueOnce([{ extversion: "2.26.2" }]); // after

    await upgradeTimescaleDb("postgres://localhost/test");

    expect(logger.info).toHaveBeenCalledWith("[timescaledb] Extension already at 2.26.2");
  });

  it("skips when timescaledb is not installed", async () => {
    mockSqlTagged.mockResolvedValueOnce([]); // no extension

    await upgradeTimescaleDb("postgres://localhost/test");

    expect(mockSqlTagged).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      "[timescaledb] Extension not installed, skipping upgrade",
    );
  });

  it("closes the connection even on error", async () => {
    mockSqlTagged.mockRejectedValueOnce(new Error("connection failed"));

    await expect(upgradeTimescaleDb("postgres://localhost/test")).rejects.toThrow(
      "connection failed",
    );
    expect(mockSqlEnd).toHaveBeenCalled();
  });
});
