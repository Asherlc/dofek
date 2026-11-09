import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClickHouseClientFromEnv } from "../src/db/clickhouse.ts";
import { captureException } from "../src/lib/error-reporting.ts";
import type { AnalyticsMicrobatchQueryClient } from "../src/processing/analytics-microbatch-bounds.ts";
import { runLocalAnalyticsBuild } from "./run-local-analytics-build.ts";

vi.mock("../src/lib/error-reporting.ts", () => ({
  captureException: vi.fn(),
}));
vi.mock("../src/db/clickhouse.ts", () => ({
  createClickHouseClientFromEnv: vi.fn(),
}));
vi.mock("../src/analytics/dbt-build.ts", () => ({
  runOwnedDbtBuild: async (
    _owner: unknown,
    _directory: string,
    _models: unknown,
    run: () => Promise<number>,
  ) => run(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("runLocalAnalyticsBuild", () => {
  it("checks owned admission before reading source bounds", async () => {
    const failure = new Error("Owner closed");
    const query = vi.fn();
    const owner = {
      client: { query },
      assertActive: vi.fn(async () => {
        throw failure;
      }),
      runSynchronousDbt: vi.fn(),
    };
    await expect(
      runLocalAnalyticsBuild({
        owner,
        artifactDirectory: "/tmp/local-owner-fixture",
        runDbt: vi.fn(),
      }),
    ).rejects.toBe(failure);
    expect(query).not.toHaveBeenCalled();
  });
  it("reports unexpected direct-entrypoint failures before rethrowing", async () => {
    const originalScriptPath = process.argv[1];
    const scriptPath = fileURLToPath(new URL("./run-local-analytics-build.ts", import.meta.url));
    const initializationError = new Error("CLICKHOUSE_URL is required");
    vi.mocked(createClickHouseClientFromEnv).mockImplementation(() => {
      throw initializationError;
    });
    vi.resetModules();
    process.argv[1] = scriptPath;

    try {
      await expect(import("./run-local-analytics-build.ts")).rejects.toBe(initializationError);
      expect(captureException).toHaveBeenCalledWith(initializationError);
    } finally {
      process.argv[1] = originalScriptPath;
    }
  });

  it("passes source-derived microbatch bounds to dbt", async () => {
    const clickHouse: AnalyticsMicrobatchQueryClient = {
      query: vi.fn(async () => ({
        json: async () => [
          {
            scalar_begin: "2025-02-03",
          },
        ],
      })),
    };
    const runDbt = vi.fn(async () => 0);

    await expect(
      runLocalAnalyticsBuild({
        owner: {
          client: clickHouse,
          assertActive: vi.fn(async () => undefined),
          runSynchronousDbt: vi.fn(),
        },
        artifactDirectory: "/tmp/local-owner-fixture",
        now: new Date("2026-07-24T12:34:56.000Z"),
        runDbt,
      }),
    ).resolves.toBeUndefined();

    expect(runDbt).toHaveBeenCalledWith([
      "run",
      "--project",
      "analytics",
      "dbt",
      "build",
      "--project-dir",
      "analytics",
      "--profiles-dir",
      "analytics",
      "--target-path",
      "/tmp/local-owner-fixture",
      "--vars",
      '{"sensor_scalar_sample_begin":"2025-02-03","deduped_sensor_begin":"2025-02-03","activity_sensor_sample_begin":"2025-02-03"}',
    ]);
  });

  it("fails when dbt exits unsuccessfully", async () => {
    const clickHouse: AnalyticsMicrobatchQueryClient = {
      query: vi.fn(async () => ({
        json: async () => [{ scalar_begin: null }],
      })),
    };

    await expect(
      runLocalAnalyticsBuild({
        owner: {
          client: clickHouse,
          assertActive: vi.fn(async () => undefined),
          runSynchronousDbt: vi.fn(),
        },
        artifactDirectory: "/tmp/local-owner-fixture",
        now: new Date("2026-07-24T12:34:56.000Z"),
        runDbt: async () => 2,
      }),
    ).rejects.toThrow("Local dbt build failed with exit code 2");
  });
});
