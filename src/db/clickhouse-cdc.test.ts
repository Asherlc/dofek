import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const peerDbClientMocks = vi.hoisted(() => ({
  Client: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  query: vi.fn(),
}));

const clickHouseClientMocks = vi.hoisted(() => ({
  close: vi.fn(),
  command: vi.fn(),
  createClickHouseClientFromEnv: vi.fn(),
}));

vi.mock("pg", () => ({
  Client: peerDbClientMocks.Client,
}));

vi.mock("./clickhouse.ts", () => ({
  createClickHouseClientFromEnv: clickHouseClientMocks.createClickHouseClientFromEnv,
}));

import { setupClickHouseCdc, setupClickHouseCdcFromEnv } from "./clickhouse-cdc.ts";

function credentialedUrl(
  protocol: "http" | "postgres",
  username: string,
  credential: string,
  hostAndPort: string,
  path: string,
): string {
  const url = new URL(`${protocol}://${hostAndPort}${path}`);
  url.username = username;
  url.password = credential;
  return url.toString();
}

describe("PeerDB ClickHouse CDC setup", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalClickHouseUrl = process.env.CLICKHOUSE_URL;
  const originalPostgresPassword = process.env.POSTGRES_PASSWORD;
  const originalTemplatePath = process.env.PEERDB_CDC_SQL_TEMPLATE_PATH;

  beforeEach(() => {
    peerDbClientMocks.Client.mockReset().mockImplementation(() => peerDbClientMocks);
    peerDbClientMocks.connect.mockReset().mockResolvedValue(undefined);
    peerDbClientMocks.end.mockReset().mockResolvedValue(undefined);
    peerDbClientMocks.query.mockReset().mockResolvedValue(undefined);
    clickHouseClientMocks.command.mockReset().mockResolvedValue(undefined);
    clickHouseClientMocks.close.mockReset().mockResolvedValue(undefined);
    clickHouseClientMocks.createClickHouseClientFromEnv
      .mockReset()
      .mockReturnValue(clickHouseClientMocks);
    delete process.env.PEERDB_CDC_SQL_TEMPLATE_PATH;
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    if (originalClickHouseUrl === undefined) {
      delete process.env.CLICKHOUSE_URL;
    } else {
      process.env.CLICKHOUSE_URL = originalClickHouseUrl;
    }
    if (originalPostgresPassword === undefined) {
      delete process.env.POSTGRES_PASSWORD;
    } else {
      process.env.POSTGRES_PASSWORD = originalPostgresPassword;
    }
    if (originalTemplatePath === undefined) {
      delete process.env.PEERDB_CDC_SQL_TEMPLATE_PATH;
    } else {
      process.env.PEERDB_CDC_SQL_TEMPLATE_PATH = originalTemplatePath;
    }
  });

  it("executes a declarative PeerDB SQL template with escaped runtime values", async () => {
    const peerDbQueries: string[] = [];
    const clickHouseCommands: string[] = [];

    await setupClickHouseCdc({
      peerDbClient: {
        async query(queryText) {
          peerDbQueries.push(queryText);
        },
      },
      clickHouseClient: {
        async command(options) {
          clickHouseCommands.push(options.query);
        },
      },
      templateSql: "host = {{POSTGRES_HOST}}, password = {{POSTGRES_CREDENTIAL}}",
      templateValues: {
        clickHouseDatabase: "peerdb",
        clickHouseHost: "clickhouse",
        clickHouseCredential: "clickhouse-fixture",
        clickHousePort: 9000,
        clickHouseUser: "default",
        postgresDatabase: "health",
        postgresHost: "db",
        postgresCredential: "pa'ss\\word",
        postgresPort: 5432,
        postgresUser: "health",
      },
    });

    expect(clickHouseCommands).toEqual(["CREATE DATABASE IF NOT EXISTS peerdb"]);
    expect(peerDbQueries).toEqual(["host = 'db', password = 'pa''ss\\word'"]);
  });

  it("fails when the PeerDB SQL template references an unknown placeholder", async () => {
    await expect(
      setupClickHouseCdc({
        peerDbClient: {
          async query() {},
        },
        clickHouseClient: {
          async command() {},
        },
        templateSql: "missing = {{MISSING_VALUE}}",
        templateValues: {
          clickHouseDatabase: "peerdb",
          clickHouseHost: "clickhouse",
          clickHouseCredential: "clickhouse-fixture",
          clickHousePort: 9000,
          clickHouseUser: "default",
          postgresDatabase: "health",
          postgresHost: "db",
          postgresCredential: "fixture",
          postgresPort: 5432,
          postgresUser: "health",
        },
      }),
    ).rejects.toThrow("Unknown PeerDB SQL template placeholder: MISSING_VALUE");
  });

  it("renders the checked-in metric stream CDC template", async () => {
    const peerDbQueries: string[] = [];
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await setupClickHouseCdc({
      peerDbClient: {
        async query(queryText) {
          peerDbQueries.push(queryText);
        },
      },
      clickHouseClient: {
        async command() {},
      },
      templateSql,
      templateValues: {
        clickHouseDatabase: "peerdb",
        clickHouseHost: "clickhouse",
        clickHouseCredential: "clickhouse-fixture",
        clickHousePort: 9000,
        clickHouseUser: "default",
        postgresDatabase: "health",
        postgresHost: "db",
        postgresCredential: "fixture",
        postgresPort: 5432,
        postgresUser: "health",
      },
    });

    expect(peerDbQueries).toHaveLength(3);
    expect(peerDbQueries[0]).toContain("CREATE PEER IF NOT EXISTS dofek_postgres");
    expect(peerDbQueries[1]).toContain("CREATE PEER IF NOT EXISTS dofek_clickhouse");
    expect(peerDbQueries[2]).toContain("CREATE MIRROR IF NOT EXISTS dofek_metric_stream_cdc");
    expect(peerDbQueries.join("\n")).not.toContain("{{");
  });

  it("splits statements without splitting semicolons inside string literals", async () => {
    const peerDbQueries: string[] = [];

    await setupClickHouseCdc({
      peerDbClient: {
        async query(queryText) {
          peerDbQueries.push(queryText);
        },
      },
      clickHouseClient: {
        async command() {},
      },
      templateSql: "first {{POSTGRES_CREDENTIAL}}; second;",
      templateValues: {
        clickHouseDatabase: "peerdb",
        clickHouseHost: "clickhouse",
        clickHouseCredential: "clickhouse-fixture",
        clickHousePort: 9000,
        clickHouseUser: "default",
        postgresDatabase: "health",
        postgresHost: "db",
        postgresCredential: "semi;quote'",
        postgresPort: 5432,
        postgresUser: "health",
      },
    });

    expect(peerDbQueries).toEqual(["first 'semi;quote'''", "second"]);
  });

  it("configures PeerDB CDC from environment values and closes clients", async () => {
    process.env.DATABASE_URL = credentialedUrl(
      "postgres",
      "health",
      "pg'credential",
      "postgres.example:6543",
      "/fitness",
    );
    process.env.CLICKHOUSE_URL = credentialedUrl(
      "http",
      "analytics",
      "click\\credential",
      "clickhouse.example:8123",
      "",
    );
    process.env.POSTGRES_PASSWORD = "peerdb fixture";

    await setupClickHouseCdcFromEnv();

    expect(peerDbClientMocks.Client).toHaveBeenCalledWith({
      connectionString: credentialedUrl(
        "postgres",
        "peerdb",
        "peerdb fixture",
        "peerdb:9900",
        "/peerdb",
      ),
    });
    expect(clickHouseClientMocks.createClickHouseClientFromEnv).toHaveBeenCalled();
    expect(peerDbClientMocks.connect).toHaveBeenCalledTimes(1);
    expect(clickHouseClientMocks.command).toHaveBeenCalledWith({
      query: "CREATE DATABASE IF NOT EXISTS peerdb",
    });
    const peerDbQueries = peerDbClientMocks.query.mock.calls.map(([queryText]) =>
      String(queryText),
    );
    expect(peerDbQueries).toHaveLength(3);
    expect(peerDbQueries[0]).toContain("host = 'postgres.example'");
    expect(peerDbQueries[0]).toContain("port = 6543");
    expect(peerDbQueries[0]).toContain("password = 'pg''credential'");
    expect(peerDbQueries[1]).toContain("host = 'clickhouse'");
    expect(peerDbQueries[1]).toContain("password = 'click\\credential'");
    expect(peerDbQueries.join("\n")).not.toContain("{{");
    expect(peerDbClientMocks.end).toHaveBeenCalledTimes(1);
    expect(clickHouseClientMocks.close).toHaveBeenCalledTimes(1);
  });

  it("fails loudly when required environment values are missing", async () => {
    process.env.DATABASE_URL = credentialedUrl(
      "postgres",
      "health",
      "fixture",
      "postgres.example:6543",
      "/fitness",
    );
    process.env.CLICKHOUSE_URL = credentialedUrl(
      "http",
      "analytics",
      "fixture",
      "clickhouse.example:8123",
      "",
    );
    delete process.env.POSTGRES_PASSWORD;

    await expect(setupClickHouseCdcFromEnv()).rejects.toThrow(
      "POSTGRES_PASSWORD environment variable is required",
    );
    expect(peerDbClientMocks.Client).not.toHaveBeenCalled();
  });

  it("requires ClickHouse credentials for PeerDB setup", async () => {
    process.env.DATABASE_URL = credentialedUrl(
      "postgres",
      "health",
      "fixture",
      "postgres.example:6543",
      "/fitness",
    );
    process.env.CLICKHOUSE_URL = "http://analytics@clickhouse.example:8123";
    process.env.POSTGRES_PASSWORD = "peerdb fixture";

    await expect(setupClickHouseCdcFromEnv()).rejects.toThrow(
      "CLICKHOUSE_URL must include a password for PeerDB setup",
    );
    expect(peerDbClientMocks.Client).not.toHaveBeenCalled();
  });

  it("requires database URL credentials and database name for PeerDB setup", async () => {
    process.env.CLICKHOUSE_URL = credentialedUrl(
      "http",
      "analytics",
      "fixture",
      "clickhouse.example:8123",
      "",
    );
    process.env.POSTGRES_PASSWORD = "peerdb fixture";

    process.env.DATABASE_URL = "postgres://postgres.example:6543/fitness";
    await expect(setupClickHouseCdcFromEnv()).rejects.toThrow(
      "DATABASE_URL must include username for PeerDB setup",
    );

    process.env.DATABASE_URL = "postgres://health@postgres.example:6543/fitness";
    await expect(setupClickHouseCdcFromEnv()).rejects.toThrow(
      "DATABASE_URL must include password for PeerDB setup",
    );

    process.env.DATABASE_URL = credentialedUrl(
      "postgres",
      "health",
      "fixture",
      "postgres.example:6543",
      "",
    );
    await expect(setupClickHouseCdcFromEnv()).rejects.toThrow(
      "DATABASE_URL must include database name for PeerDB setup",
    );
    expect(peerDbClientMocks.Client).not.toHaveBeenCalled();
  });
});
