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
  const originalPeerDbHost = process.env.PEERDB_CDC_HOST;
  const originalPeerDbPort = process.env.PEERDB_CDC_PORT;
  const originalTemplatePostgresHost = process.env.PEERDB_CDC_POSTGRES_HOST;
  const originalTemplatePostgresPort = process.env.PEERDB_CDC_POSTGRES_PORT;
  const originalTemplateClickhouseHost = process.env.PEERDB_CDC_CLICKHOUSE_HOST;
  const originalTemplateClickhousePort = process.env.PEERDB_CDC_CLICKHOUSE_PORT;
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
    delete process.env.PEERDB_CDC_HOST;
    delete process.env.PEERDB_CDC_PORT;
    delete process.env.PEERDB_CDC_POSTGRES_HOST;
    delete process.env.PEERDB_CDC_POSTGRES_PORT;
    delete process.env.PEERDB_CDC_CLICKHOUSE_HOST;
    delete process.env.PEERDB_CDC_CLICKHOUSE_PORT;
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
    if (originalPeerDbHost === undefined) {
      delete process.env.PEERDB_CDC_HOST;
    } else {
      process.env.PEERDB_CDC_HOST = originalPeerDbHost;
    }
    if (originalPeerDbPort === undefined) {
      delete process.env.PEERDB_CDC_PORT;
    } else {
      process.env.PEERDB_CDC_PORT = originalPeerDbPort;
    }
    if (originalTemplatePostgresHost === undefined) {
      delete process.env.PEERDB_CDC_POSTGRES_HOST;
    } else {
      process.env.PEERDB_CDC_POSTGRES_HOST = originalTemplatePostgresHost;
    }
    if (originalTemplatePostgresPort === undefined) {
      delete process.env.PEERDB_CDC_POSTGRES_PORT;
    } else {
      process.env.PEERDB_CDC_POSTGRES_PORT = originalTemplatePostgresPort;
    }
    if (originalTemplateClickhouseHost === undefined) {
      delete process.env.PEERDB_CDC_CLICKHOUSE_HOST;
    } else {
      process.env.PEERDB_CDC_CLICKHOUSE_HOST = originalTemplateClickhouseHost;
    }
    if (originalTemplateClickhousePort === undefined) {
      delete process.env.PEERDB_CDC_CLICKHOUSE_PORT;
    } else {
      process.env.PEERDB_CDC_CLICKHOUSE_PORT = originalTemplateClickhousePort;
    }
    if (originalTemplatePath === undefined) {
      delete process.env.PEERDB_CDC_SQL_TEMPLATE_PATH;
    } else {
      process.env.PEERDB_CDC_SQL_TEMPLATE_PATH = originalTemplatePath;
    }
  });

  it("executes a declarative PeerDB SQL template with escaped runtime values", async () => {
    const peerDbQueries: string[] = [];
    const sourcePostgresQueries: string[] = [];
    const clickHouseCommands: string[] = [];

    await setupClickHouseCdc({
      peerDbClient: {
        async query(queryText) {
          peerDbQueries.push(queryText);
        },
      },
      sourcePostgresClient: {
        async query(queryText) {
          sourcePostgresQueries.push(queryText);
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
    expect(sourcePostgresQueries).toHaveLength(1);
    expect(sourcePostgresQueries[0]).toContain("CREATE PUBLICATION");
    expect(sourcePostgresQueries[0]).toContain("ALTER PUBLICATION");
    expect(peerDbQueries).toEqual(["host = 'db', password = 'pa''ss\\word'"]);
  });

  it("fails when the PeerDB SQL template references an unknown placeholder", async () => {
    await expect(
      setupClickHouseCdc({
        peerDbClient: {
          async query() {},
        },
        sourcePostgresClient: {
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
    const sourcePostgresQueries: string[] = [];
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await setupClickHouseCdc({
      peerDbClient: {
        async query(queryText) {
          peerDbQueries.push(queryText);
        },
      },
      sourcePostgresClient: {
        async query(queryText) {
          sourcePostgresQueries.push(queryText);
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
    expect(sourcePostgresQueries.join("\n")).toContain("peerdb_metric_stream_publication");
  });

  it("splits statements without splitting semicolons inside string literals", async () => {
    const peerDbQueries: string[] = [];

    await setupClickHouseCdc({
      peerDbClient: {
        async query(queryText) {
          peerDbQueries.push(queryText);
        },
      },
      sourcePostgresClient: {
        async query() {},
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
    expect(peerDbClientMocks.Client).toHaveBeenCalledWith({
      connectionString: credentialedUrl(
        "postgres",
        "health",
        "pg'credential",
        "postgres.example:6543",
        "/fitness",
      ),
    });
    expect(clickHouseClientMocks.createClickHouseClientFromEnv).toHaveBeenCalled();
    expect(peerDbClientMocks.connect).toHaveBeenCalledTimes(2);
    expect(clickHouseClientMocks.command).toHaveBeenCalledWith({
      query: "CREATE DATABASE IF NOT EXISTS peerdb",
    });
    const peerDbQueries = peerDbClientMocks.query.mock.calls.map(([queryText]) =>
      String(queryText),
    );
    expect(peerDbQueries).toHaveLength(4);
    expect(peerDbQueries[0]).toContain("peerdb_metric_stream_publication");
    expect(peerDbQueries[1]).toContain("host = 'postgres.example'");
    expect(peerDbQueries[1]).toContain("port = 6543");
    expect(peerDbQueries[1]).toContain("password = 'pg''credential'");
    expect(peerDbQueries[2]).toContain("host = 'clickhouse.example'");
    expect(peerDbQueries[2]).toContain("password = 'click\\credential'");
    expect(peerDbQueries.join("\n")).not.toContain("{{");
    expect(peerDbClientMocks.end).toHaveBeenCalledTimes(2);
    expect(clickHouseClientMocks.close).toHaveBeenCalledTimes(1);
  });

  it("maps localhost source hosts to Docker compose service names", async () => {
    process.env.DATABASE_URL = credentialedUrl(
      "postgres",
      "health",
      "pg'credential",
      "localhost:6543",
      "/fitness",
    );
    process.env.CLICKHOUSE_URL = credentialedUrl(
      "http",
      "analytics",
      "click\\credential",
      "localhost:8123",
      "",
    );
    process.env.POSTGRES_PASSWORD = "peerdb fixture";

    await setupClickHouseCdcFromEnv();

    const peerDbQueries = peerDbClientMocks.query.mock.calls.map(([queryText]) =>
      String(queryText),
    );
    const peerDbQueryPostgres = String(peerDbQueries[1]);
    const peerDbQueryClickhouse = String(peerDbQueries[2]);
    expect(peerDbQueryPostgres).toContain("host = 'db'");
    expect(peerDbQueryPostgres).toContain("port = 5432");
    expect(peerDbQueryClickhouse).toContain("host = 'clickhouse'");
    expect(peerDbQueryClickhouse).toContain("port = 9000");
  });

  it("allows overriding template hosts and ports", async () => {
    process.env.DATABASE_URL = credentialedUrl(
      "postgres",
      "health",
      "pg'credential",
      "localhost:6543",
      "/fitness",
    );
    process.env.CLICKHOUSE_URL = credentialedUrl(
      "http",
      "analytics",
      "click\\credential",
      "localhost:8123",
      "",
    );
    process.env.POSTGRES_PASSWORD = "peerdb fixture";
    process.env.PEERDB_CDC_POSTGRES_HOST = "postgres.internal";
    process.env.PEERDB_CDC_POSTGRES_PORT = "6545";
    process.env.PEERDB_CDC_CLICKHOUSE_HOST = "clickhouse.internal";
    process.env.PEERDB_CDC_CLICKHOUSE_PORT = "9010";

    await setupClickHouseCdcFromEnv();

    const peerDbQueries = peerDbClientMocks.query.mock.calls.map(([queryText]) =>
      String(queryText),
    );
    const peerDbQueryPostgres = String(peerDbQueries[1]);
    const peerDbQueryClickhouse = String(peerDbQueries[2]);
    expect(peerDbQueryPostgres).toContain("host = 'postgres.internal'");
    expect(peerDbQueryPostgres).toContain("port = 6545");
    expect(peerDbQueryClickhouse).toContain("host = 'clickhouse.internal'");
    expect(peerDbQueryClickhouse).toContain("port = 9010");
  });

  it("rejects malformed template override ports", async () => {
    process.env.DATABASE_URL = credentialedUrl(
      "postgres",
      "health",
      "pg'credential",
      "localhost:5435",
      "/fitness",
    );
    process.env.CLICKHOUSE_URL = credentialedUrl(
      "http",
      "analytics",
      "click\\credential",
      "localhost:8123",
      "",
    );
    process.env.POSTGRES_PASSWORD = "peerdb fixture";
    process.env.PEERDB_CDC_POSTGRES_PORT = "5432abc";

    await expect(setupClickHouseCdcFromEnv()).rejects.toThrow(
      "PEERDB_CDC_POSTGRES_PORT must be a valid TCP port",
    );
  });

  it("rejects malformed PeerDB override port", async () => {
    process.env.DATABASE_URL = credentialedUrl(
      "postgres",
      "health",
      "pg'credential",
      "localhost:5435",
      "/fitness",
    );
    process.env.CLICKHOUSE_URL = credentialedUrl(
      "http",
      "analytics",
      "click\\credential",
      "localhost:8123",
      "",
    );
    process.env.POSTGRES_PASSWORD = "peerdb fixture";
    process.env.PEERDB_CDC_PORT = "9,900";

    await expect(setupClickHouseCdcFromEnv()).rejects.toThrow(
      "PEERDB_CDC_PORT must be a valid TCP port",
    );
  });

  it("rejects blank PeerDB host override", async () => {
    process.env.DATABASE_URL = credentialedUrl(
      "postgres",
      "health",
      "pg'credential",
      "localhost:5435",
      "/fitness",
    );
    process.env.CLICKHOUSE_URL = credentialedUrl(
      "http",
      "analytics",
      "click\\credential",
      "localhost:8123",
      "",
    );
    process.env.POSTGRES_PASSWORD = "peerdb fixture";
    process.env.PEERDB_CDC_HOST = "  ";

    await expect(setupClickHouseCdcFromEnv()).rejects.toThrow(
      "PEERDB_CDC_HOST must be a non-empty host",
    );
  });

  it("rejects blank template host override", async () => {
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
      "localhost:8123",
      "",
    );
    process.env.POSTGRES_PASSWORD = "peerdb fixture";
    process.env.PEERDB_CDC_POSTGRES_HOST = "\t";

    await expect(setupClickHouseCdcFromEnv()).rejects.toThrow(
      "PEERDB_CDC_POSTGRES_HOST must be a non-empty host",
    );
  });

  it("allows overriding the PeerDB target host and port", async () => {
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
    process.env.PEERDB_CDC_HOST = "127.0.0.1";
    process.env.PEERDB_CDC_PORT = "9902";

    await setupClickHouseCdcFromEnv();

    expect(peerDbClientMocks.Client).toHaveBeenCalledWith({
      connectionString: credentialedUrl(
        "postgres",
        "peerdb",
        "peerdb fixture",
        "127.0.0.1:9902",
        "/peerdb",
      ),
    });
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
