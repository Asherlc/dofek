import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/clickhouse-cdc.ts", () => ({
  setupClickHouseCdcFromEnv: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  close: vi.fn().mockResolvedValue(undefined),
  captureException: vi.fn(),
  init: vi.fn(),
}));

import { captureException, close, init } from "@sentry/node";
import { setupClickHouseCdcFromEnv } from "../src/db/clickhouse-cdc.ts";
import { main } from "./run-clickhouse-cdc.ts";

const mockSetupClickHouseCdcFromEnv = vi.mocked(setupClickHouseCdcFromEnv);
const mockSentryInit = vi.mocked(init);
const mockSentryClose = vi.mocked(close);
const mockSentryCapture = vi.mocked(captureException);

const TRACKED_ENV_VARS = [
  "DATABASE_URL",
  "CLICKHOUSE_HOST",
  "CLICKHOUSE_HTTP_PORT",
  "CLICKHOUSE_PASSWORD",
  "CLICKHOUSE_PORT",
  "CLICKHOUSE_URL",
  "PEERDB_CDC_HOST",
  "PEERDB_CDC_PORT",
  "POSTGRES_DB",
  "POSTGRES_HOST",
  "POSTGRES_PASSWORD",
  "POSTGRES_PORT",
  "POSTGRES_USER",
  "SENTRY_DSN",
  "SENTRY_DSN_unencrypted",
] as const;

describe("run-clickhouse-cdc", () => {
  const originalValues: Record<(typeof TRACKED_ENV_VARS)[number], string | undefined> = {
    DATABASE_URL: undefined,
    CLICKHOUSE_HOST: undefined,
    CLICKHOUSE_HTTP_PORT: undefined,
    CLICKHOUSE_PASSWORD: undefined,
    CLICKHOUSE_PORT: undefined,
    CLICKHOUSE_URL: undefined,
    PEERDB_CDC_HOST: undefined,
    PEERDB_CDC_PORT: undefined,
    POSTGRES_DB: undefined,
    POSTGRES_HOST: undefined,
    POSTGRES_PASSWORD: undefined,
    POSTGRES_PORT: undefined,
    POSTGRES_USER: undefined,
    SENTRY_DSN: undefined,
    SENTRY_DSN_unencrypted: undefined,
  };

  const restoreProcess = () => {
    for (const envName of TRACKED_ENV_VARS) {
      const originalValue = originalValues[envName];
      if (originalValue === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = originalValue;
      }
    }
  };

  beforeEach(() => {
    for (const envName of TRACKED_ENV_VARS) {
      originalValues[envName] = process.env[envName];
      delete process.env[envName];
    }

    mockSetupClickHouseCdcFromEnv.mockReset().mockResolvedValue(undefined);
    mockSentryInit.mockReset();
    mockSentryClose.mockReset();
    mockSentryCapture.mockReset();
    vi.spyOn(process, "exit").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreProcess();
  });

  it("applies local defaults, initializes Sentry, and exits 0 on success", async () => {
    process.env.POSTGRES_HOST = "localhost";
    process.env.POSTGRES_USER = "user";
    process.env.POSTGRES_PASSWORD = "postgres-password";
    process.env.POSTGRES_DB = "health";
    process.env.POSTGRES_PORT = "5439";
    process.env.CLICKHOUSE_PASSWORD = "clickhouse-password";
    process.env.CLICKHOUSE_HOST = "127.0.0.1";
    process.env.CLICKHOUSE_HTTP_PORT = "8128";
    process.env.DATABASE_URL = "postgres://user:postgres-password@localhost:5439/health";
    process.env.CLICKHOUSE_URL = "http://default:clickhouse-password@127.0.0.1:8128";
    process.env.SENTRY_DSN = "dsn-local";

    await expect(main()).resolves.toBeUndefined();

    expect(mockSetupClickHouseCdcFromEnv).toHaveBeenCalledTimes(1);
    expect(mockSentryInit).toHaveBeenCalledWith({
      dsn: "dsn-local",
      skipOpenTelemetrySetup: true,
    });
    expect(process.env.DATABASE_URL).toBe(
      "postgres://user:postgres-password@localhost:5439/health",
    );
    expect(process.env.CLICKHOUSE_URL).toBe("http://default:clickhouse-password@127.0.0.1:8128");
    expect(process.env.PEERDB_CDC_HOST).toBe("127.0.0.1");
    expect(process.env.PEERDB_CDC_PORT).toBe("9900");
    expect(mockSentryClose).toHaveBeenCalledWith(2_000);
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("captures and exits 1 when setup fails", async () => {
    process.env.POSTGRES_PASSWORD = "postgres-placeholder";
    process.env.CLICKHOUSE_PASSWORD = "clickhouse-password";
    process.env.DATABASE_URL = "postgres://user:postgres-placeholder@localhost:5432/health";
    process.env.CLICKHOUSE_URL = "http://default:clickhouse-password@127.0.0.1:8123";
    process.env.SENTRY_DSN = "dsn-local";
    mockSetupClickHouseCdcFromEnv.mockRejectedValue(new Error("boom"));

    await expect(main()).resolves.toBeUndefined();

    expect(mockSetupClickHouseCdcFromEnv).toHaveBeenCalledTimes(1);
    expect(mockSentryCapture).toHaveBeenCalledTimes(1);
    expect(mockSentryClose).toHaveBeenCalledWith(2_000);
    expect(mockSentryInit).toHaveBeenCalledWith({
      dsn: "dsn-local",
      skipOpenTelemetrySetup: true,
    });
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
