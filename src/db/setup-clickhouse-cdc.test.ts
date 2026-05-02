import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./clickhouse-cdc.ts", () => ({
  setupClickHouseCdcFromEnv: vi.fn(),
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  close: vi.fn(),
  init: vi.fn(),
}));

import * as Sentry from "@sentry/node";
import { logger } from "../logger.ts";
import { setupClickHouseCdcFromEnv } from "./clickhouse-cdc.ts";

const mockSetupClickHouseCdcFromEnv = vi.mocked(setupClickHouseCdcFromEnv);
const mockLogger = vi.mocked(logger);

describe("setup-clickhouse-cdc main()", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mockSetupClickHouseCdcFromEnv.mockReset().mockResolvedValue(undefined);
    vi.mocked(Sentry.captureException).mockReset();
    vi.mocked(Sentry.close).mockReset().mockResolvedValue(true);
    vi.mocked(Sentry.init).mockReset();
    mockLogger.error.mockReset();
    mockLogger.info.mockReset();
  });

  it("configures PeerDB CDC and logs success", async () => {
    const { main } = await import("./setup-clickhouse-cdc.ts");

    await main();

    expect(mockSetupClickHouseCdcFromEnv).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      "[clickhouse-cdc] PeerDB metric_stream CDC mirror is configured",
    );
  });

  it("initializes and flushes Sentry on direct-run failure", async () => {
    const previousArgv = process.argv[1];
    const previousExitCode = process.exitCode;
    const failure = new Error("setup failed");
    vi.stubEnv("SENTRY_DSN", "https://key@sentry.example/123");
    mockSetupClickHouseCdcFromEnv.mockRejectedValueOnce(failure);
    process.argv[1] = "setup-clickhouse-cdc.ts";
    process.exitCode = undefined;

    try {
      await import("./setup-clickhouse-cdc.ts");
      await vi.waitFor(() => {
        expect(mockLogger.error).toHaveBeenCalledWith("[clickhouse-cdc] Error: setup failed");
      });
    } finally {
      if (previousArgv === undefined) {
        delete process.argv[1];
      } else {
        process.argv[1] = previousArgv;
      }
      process.exitCode = previousExitCode;
    }

    expect(Sentry.init).toHaveBeenCalledWith({
      dsn: "https://key@sentry.example/123",
      skipOpenTelemetrySetup: true,
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(failure);
    expect(Sentry.close).toHaveBeenCalledWith(2000);
  });
});
