import * as Sentry from "@sentry/node";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../src/db/clickhouse.ts";
import {
  assertClickHouseCdcHealth,
  checkClickHouseCdcHealth,
} from "../src/db/clickhouse-cdc-health.ts";
import { main } from "./check-clickhouse-cdc.ts";

const pgClientInstances = vi.hoisted<MockPgClient[]>(() => []);

class MockPgClient {
  readonly connectionString: string;
  connect = vi.fn().mockResolvedValue(undefined);
  end = vi.fn().mockResolvedValue(undefined);
  query = vi.fn().mockResolvedValue({ rows: [] });

  constructor(options: { connectionString: string }) {
    this.connectionString = options.connectionString;
    pgClientInstances.push(this);
  }
}

vi.mock("pg", () => ({
  Client: vi.fn(function vitestConstructor(options: { connectionString: string }) {
    return new MockPgClient(options);
  }),
}));

vi.mock("../src/db/clickhouse.ts", () => ({
  createClickHouseClientFromEnv: vi.fn(),
}));

vi.mock("../src/db/clickhouse-cdc-health.ts", () => ({
  assertClickHouseCdcHealth: vi.fn(),
  checkClickHouseCdcHealth: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
  init: vi.fn(),
  setContext: vi.fn(),
}));

const mockedCreateClickHouseClientFromEnv = vi.mocked(createClickHouseClientFromEnv);
const mockedCheckClickHouseCdcHealth = vi.mocked(checkClickHouseCdcHealth);
const mockedAssertClickHouseCdcHealth = vi.mocked(assertClickHouseCdcHealth);
const mockedSentryCaptureException = vi.mocked(Sentry.captureException);
const mockedSentryClose = vi.mocked(Sentry.close);
const mockedSentryInit = vi.mocked(Sentry.init);
const mockedSentrySetContext = vi.mocked(Sentry.setContext);

const trackedEnvVars = [
  "CLICKHOUSE_URL",
  "DATABASE_URL",
  "PEERDB_CDC_HOST",
  "PEERDB_CDC_PASSWORD",
  "PEERDB_CDC_PORT",
  "PEERDB_PASSWORD",
  "POSTGRES_PASSWORD",
  "SENTRY_DSN",
  "SENTRY_DSN_unencrypted",
] as const;

describe("check-clickhouse-cdc", () => {
  let clickHouseClient: ClickHouseClient;

  const originalValues: Record<(typeof trackedEnvVars)[number], string | undefined> = {
    CLICKHOUSE_URL: undefined,
    DATABASE_URL: undefined,
    PEERDB_CDC_HOST: undefined,
    PEERDB_CDC_PASSWORD: undefined,
    PEERDB_CDC_PORT: undefined,
    PEERDB_PASSWORD: undefined,
    POSTGRES_PASSWORD: undefined,
    SENTRY_DSN: undefined,
    SENTRY_DSN_unencrypted: undefined,
  };

  beforeEach(() => {
    for (const envName of trackedEnvVars) {
      originalValues[envName] = process.env[envName];
      delete process.env[envName];
    }
    pgClientInstances.length = 0;
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation(() => undefined);
    clickHouseClient = {
      close: vi.fn().mockResolvedValue(undefined),
      command: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue([]) }),
    };
    mockedCreateClickHouseClientFromEnv.mockReturnValue(clickHouseClient);
    mockedAssertClickHouseCdcHealth.mockReset();
    mockedCheckClickHouseCdcHealth.mockResolvedValue({
      evidence: {
        peerDbMirrors: [
          {
            name: "dofek_fitness_raw_analytics",
            status: "1",
            updatedAt: "2026-06-17 22:09:34.510293",
            workflowId: "dofek_fitness_raw_analytics-peerflow",
          },
        ],
        replicationSlots: [],
      },
      issues: [],
      mirrorCount: 1,
      peerDbMirrorCount: 1,
      slotCount: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const envName of trackedEnvVars) {
      const originalValue = originalValues[envName];
      if (originalValue === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = originalValue;
      }
    }
  });

  it("passes PeerDB catalog state into the health check and records evidence on failure", async () => {
    process.env.CLICKHOUSE_URL = "http://default:clickhouse-password@clickhouse:8123";
    process.env.DATABASE_URL = "postgres://health:postgres-password@db:5432/health";
    process.env.POSTGRES_PASSWORD = "peerdb-password";
    process.env.PEERDB_CDC_HOST = "peerdb";
    process.env.PEERDB_CDC_PORT = "9900";
    process.env.SENTRY_DSN = "dsn";
    const healthError = new Error("ClickHouse CDC health check failed");
    mockedAssertClickHouseCdcHealth.mockImplementation(() => {
      throw healthError;
    });

    await expect(main()).resolves.toBeUndefined();

    expect(Client).toHaveBeenCalledTimes(2);
    expect(pgClientInstances.map((client) => client.connectionString)).toEqual([
      "postgres://health:postgres-password@db:5432/health",
      "postgres://peerdb:peerdb-password@peerdb:9900/peerdb",
    ]);
    expect(mockedCheckClickHouseCdcHealth).toHaveBeenCalledWith({
      clickHouseClient: expect.any(Object),
      peerDbClient: pgClientInstances[1],
      postgresClient: pgClientInstances[0],
    });
    expect(mockedSentrySetContext).toHaveBeenCalledWith("clickhouse_cdc_health", {
      evidence: {
        peerDbMirrors: [
          {
            name: "dofek_fitness_raw_analytics",
            status: "1",
            updatedAt: "2026-06-17 22:09:34.510293",
            workflowId: "dofek_fitness_raw_analytics-peerflow",
          },
        ],
        replicationSlots: [],
      },
      issues: [],
      mirrorCount: 1,
      peerDbMirrorCount: 1,
      slotCount: 0,
    });
    expect(mockedSentryCaptureException).toHaveBeenCalledWith(healthError);
    expect(mockedSentryInit).toHaveBeenCalledWith({
      dsn: "dsn",
      skipOpenTelemetrySetup: true,
    });
    expect(mockedSentryClose).toHaveBeenCalledWith(2_000);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("uses dedicated PeerDB credentials and routes IPv6 localhost DATABASE_URL to 127.0.0.1", async () => {
    process.env.CLICKHOUSE_URL = "http://default:clickhouse-password@clickhouse:8123";
    process.env.DATABASE_URL = "postgres://health:postgres-password@[::1]:5432/health";
    process.env.PEERDB_CDC_PASSWORD = "peerdb-dedicated-password";
    process.env.PEERDB_CDC_PORT = "9900";

    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(main()).resolves.toBeUndefined();

    expect(pgClientInstances.map((client) => client.connectionString)).toEqual([
      "postgres://health:postgres-password@[::1]:5432/health",
      "postgres://peerdb:peerdb-dedicated-password@127.0.0.1:9900/peerdb",
    ]);
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(consoleLog).toHaveBeenCalledWith(
      "[clickhouse-cdc-health] ok: checked 0 slots and 1 mirror",
    );
  });
});
