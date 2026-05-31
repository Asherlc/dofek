import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClickHouseCommandClient } from "./clickhouse.ts";

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
  query: vi.fn(),
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

function isPeerDbMirrorReconciliationQuery(queryText: string): boolean {
  return (
    queryText.includes("metric_stream_analytics_point_exclude_position") ||
    queryText.includes("legacy_metric_stream_cdc_mirror_exists") ||
    queryText.includes("raw_analytics_mirror_config") ||
    queryText.includes("existing_mirror_name")
  );
}

function normalizeSql(queryText: string): string {
  return queryText.replace(/\s+/g, " ").trim();
}

function createTestClickHouseClient(
  commands: string[] = [],
  destinationRowCount = 0,
): ClickHouseCommandClient {
  return {
    async command(options) {
      commands.push(options.query);
    },
    async query<TRow extends object>() {
      return {
        async json(): Promise<TRow[]> {
          return JSON.parse(`[{"row_count":${destinationRowCount}}]`);
        },
      };
    },
  };
}

describe("PeerDB ClickHouse CDC setup", () => {
  const rawAnalyticsTables = [
    "activity",
    "sleep_session",
    "sleep_stage",
    "daily_metrics",
    "food_entry",
    "health_event",
    "lab_panel",
    "lab_result",
    "journal_entry",
    "provider",
    "provider_priority",
    "device_priority",
    "sensor_provider_priority",
    "sensor_device_priority",
    "user_profile",
  ];
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
    clickHouseClientMocks.query.mockReset().mockResolvedValue({
      json: async () => [{ row_count: 0 }],
    });
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
          if (isPeerDbMirrorReconciliationQuery(queryText)) {
            return { rows: [] };
          }
          peerDbQueries.push(queryText);
          return {};
        },
      },
      sourcePostgresClient: {
        async query(queryText) {
          sourcePostgresQueries.push(queryText);
        },
      },
      clickHouseClient: createTestClickHouseClient(clickHouseCommands),
      templateSql: "host = {{POSTGRES_HOST}}, password = {{POSTGRES_CREDENTIAL}}",
      templateValues: {
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

    expect(clickHouseCommands).not.toContain("CREATE DATABASE IF NOT EXISTS peerdb");
    expect(clickHouseCommands).toContain(
      "ALTER TABLE postgres_fitness.metric_stream ADD COLUMN IF NOT EXISTS _peerdb_synced_at DateTime64(9) DEFAULT now()",
    );
    for (const rawAnalyticsTable of rawAnalyticsTables) {
      expect(clickHouseCommands).toContain(
        `ALTER TABLE postgres_fitness.${rawAnalyticsTable} ADD COLUMN IF NOT EXISTS _peerdb_synced_at DateTime64(9) DEFAULT now()`,
      );
    }
    expect(sourcePostgresQueries).toHaveLength(2);
    expect(sourcePostgresQueries[0]).toContain("CREATE PUBLICATION");
    expect(sourcePostgresQueries[0]).toContain("ALTER PUBLICATION");
    for (const rawAnalyticsTable of rawAnalyticsTables) {
      expect(sourcePostgresQueries[0]).toContain(`('${rawAnalyticsTable}')`);
    }
    const metricStreamPublicationQueryText = sourcePostgresQueries.at(1);
    expect(metricStreamPublicationQueryText).toBeDefined();
    if (metricStreamPublicationQueryText === undefined) {
      throw new Error("Expected metric_stream publication setup query");
    }
    const metricStreamPublicationQuery = normalizeSql(metricStreamPublicationQueryText);
    expect(metricStreamPublicationQuery).toContain(
      normalizeSql(`
        SELECT chunks.chunk_schema, chunks.chunk_name
        FROM timescaledb_information.chunks AS chunks
        JOIN pg_class chunk_class
          ON chunk_class.relname = chunks.chunk_name
        JOIN pg_namespace chunk_namespace
          ON chunk_namespace.oid = chunk_class.relnamespace
         AND chunk_namespace.nspname = chunks.chunk_schema
        CROSS JOIN pg_publication publication
        LEFT JOIN pg_publication_rel publication_entry
          ON publication_entry.prpubid = publication.oid
         AND publication_entry.prrelid = chunk_class.oid
        WHERE chunks.hypertable_schema = 'fitness'
          AND chunks.hypertable_name = 'metric_stream'
          AND publication.pubname = 'peerdb_metric_stream_no_imu'
          AND publication_entry.prrelid IS NULL
      `),
    );
    expect(metricStreamPublicationQuery).toContain(
      "ALTER PUBLICATION peerdb_metric_stream_no_imu ADD TABLE %I.%I WHERE (channel <> %L)",
    );
    expect(metricStreamPublicationQuery).toContain(
      "SELECT fitness.ensure_metric_stream_peerdb_publication_chunks();",
    );
    expect(metricStreamPublicationQuery).toContain(
      normalizeSql(`
        SELECT job_id, schedule_interval, scheduled
        INTO existing_job_id, existing_schedule_interval, existing_scheduled
        FROM timescaledb_information.jobs
        WHERE proc_schema = 'fitness'
          AND proc_name = 'ensure_metric_stream_peerdb_publication_chunks'
        ORDER BY job_id
        LIMIT 1;
      `),
    );
    expect(metricStreamPublicationQuery).toContain(
      "PERFORM public.add_job( 'fitness.ensure_metric_stream_peerdb_publication_chunks'::regproc, INTERVAL '1 hour', job_name => 'ensure_metric_stream_peerdb_publication_chunks' );",
    );
    expect(metricStreamPublicationQuery).toContain(
      "PERFORM public.alter_job( existing_job_id, schedule_interval => INTERVAL '1 hour', scheduled => true, job_name => 'ensure_metric_stream_peerdb_publication_chunks' );",
    );
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
        clickHouseClient: createTestClickHouseClient(),
        templateSql: "missing = {{MISSING_VALUE}}",
        templateValues: {
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
          if (isPeerDbMirrorReconciliationQuery(queryText)) {
            return { rows: [] };
          }
          peerDbQueries.push(queryText);
          return {};
        },
      },
      sourcePostgresClient: {
        async query(queryText) {
          sourcePostgresQueries.push(queryText);
        },
      },
      clickHouseClient: createTestClickHouseClient(),
      templateSql,
      templateValues: {
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

    expect(peerDbQueries).toHaveLength(6);
    expect(peerDbQueries[0]).toContain("CREATE PEER IF NOT EXISTS dofek_postgres");
    expect(peerDbQueries[1]).toContain(
      "CREATE PEER IF NOT EXISTS dofek_clickhouse_postgres_fitness",
    );
    expect(peerDbQueries[2]).toContain("CREATE MIRROR IF NOT EXISTS dofek_metric_stream_analytics");
    expect(peerDbQueries[3]).toContain("CREATE MIRROR IF NOT EXISTS dofek_fitness_raw_analytics");
    expect(peerDbQueries[4]).toContain(
      "CREATE MIRROR IF NOT EXISTS dofek_provider_inventory_raw_analytics",
    );
    expect(peerDbQueries[5]).toContain(
      "CREATE MIRROR IF NOT EXISTS dofek_sensor_priority_raw_analytics",
    );
    expect(peerDbQueries[1]).toContain("database = 'postgres_fitness'");
    expect(peerDbQueries[2]).toContain("TO dofek_clickhouse_postgres_fitness");
    expect(peerDbQueries[2]).toContain(
      "exclude: [device_id, source_type, vector, point, metadata]",
    );
    expect(peerDbQueries[2]).not.toContain("latitude");
    expect(peerDbQueries[2]).not.toContain("longitude");
    expect(peerDbQueries[3]).toContain("TO dofek_clickhouse_postgres_fitness");
    expect(peerDbQueries[4]).toContain("TO dofek_clickhouse_postgres_fitness");
    expect(peerDbQueries[5]).toContain("TO dofek_clickhouse_postgres_fitness");
    const rawMirrorSql = `${peerDbQueries[3]}\n${peerDbQueries[4]}\n${peerDbQueries[5]}`;
    for (const rawAnalyticsTable of rawAnalyticsTables) {
      expect(rawMirrorSql).toContain(`from: fitness.${rawAnalyticsTable}`);
      expect(rawMirrorSql).toContain(`to: ${rawAnalyticsTable}`);
    }
    expect(peerDbQueries.join("\n")).not.toContain("{{");
    expect(sourcePostgresQueries.join("\n")).toContain("peerdb_metric_stream_publication");
  });

  it("does not resubmit mirrors that already exist in PeerDB", async () => {
    const peerDbQueries: string[] = [];
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await setupClickHouseCdc({
      peerDbClient: {
        async query(queryText) {
          const query = String(queryText);
          if (query.includes("metric_stream_analytics_point_exclude_position")) {
            return {
              rows: [{ metric_stream_analytics_point_exclude_position: 1 }],
            };
          }
          if (query.includes("legacy_metric_stream_cdc_mirror_exists")) {
            return { rows: [] };
          }
          if (query.includes("raw_analytics_mirror_config")) {
            return {
              rows: [
                {
                  name: "dofek_fitness_raw_analytics",
                  raw_analytics_mirror_config:
                    "activity sleep_session sleep_stage daily_metrics provider provider_priority device_priority user_profile",
                },
                {
                  name: "dofek_provider_inventory_raw_analytics",
                  raw_analytics_mirror_config:
                    "food_entry health_event lab_panel lab_result journal_entry",
                },
                {
                  name: "dofek_sensor_priority_raw_analytics",
                  raw_analytics_mirror_config: "sensor_provider_priority sensor_device_priority",
                },
              ],
            };
          }
          if (query.includes("existing_mirror_name")) {
            return {
              rows: [
                { existing_mirror_name: "dofek_metric_stream_analytics" },
                { existing_mirror_name: "dofek_fitness_raw_analytics" },
                { existing_mirror_name: "dofek_provider_inventory_raw_analytics" },
                { existing_mirror_name: "dofek_sensor_priority_raw_analytics" },
              ],
            };
          }
          peerDbQueries.push(query);
          return {};
        },
      },
      sourcePostgresClient: {
        async query() {},
      },
      clickHouseClient: createTestClickHouseClient(),
      templateSql,
      templateValues: {
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

    expect(peerDbQueries).toHaveLength(2);
    expect(peerDbQueries[0]).toContain("CREATE PEER IF NOT EXISTS dofek_postgres");
    expect(peerDbQueries[1]).toContain(
      "CREATE PEER IF NOT EXISTS dofek_clickhouse_postgres_fitness",
    );
    expect(peerDbQueries.join("\n")).not.toContain("CREATE MIRROR");
  });

  it("continues when PeerDB reports an existing managed mirror workflow", async () => {
    const peerDbQueries: string[] = [];
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await setupClickHouseCdc({
      peerDbClient: {
        async query(queryText) {
          const query = String(queryText);
          if (isPeerDbMirrorReconciliationQuery(query)) {
            return { rows: [] };
          }
          peerDbQueries.push(query);
          if (query.includes("CREATE MIRROR IF NOT EXISTS dofek_metric_stream_analytics")) {
            throw new Error(
              'unable to submit job: "status: AlreadyExists, message: "workflow already exists for flow: dofek_metric_stream_analytics""',
            );
          }
          return {};
        },
      },
      sourcePostgresClient: {
        async query() {},
      },
      clickHouseClient: createTestClickHouseClient(),
      templateSql,
      templateValues: {
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

    expect(peerDbQueries).toContainEqual(
      expect.stringContaining("CREATE MIRROR IF NOT EXISTS dofek_metric_stream_analytics"),
    );
    expect(peerDbQueries).toContainEqual(
      expect.stringContaining("CREATE MIRROR IF NOT EXISTS dofek_fitness_raw_analytics"),
    );
  });

  it("recreates the metric stream analytics mirror when the existing mirror still includes point", async () => {
    const peerDbQueries: string[] = [];
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await setupClickHouseCdc({
      peerDbClient: {
        async query(queryText) {
          const query = String(queryText);
          if (isPeerDbMirrorReconciliationQuery(query)) {
            return {
              rows: query.includes("metric_stream_analytics_point_exclude_position")
                ? [{ metric_stream_analytics_point_exclude_position: 0 }]
                : [],
            };
          }
          peerDbQueries.push(query);
          return {};
        },
      },
      sourcePostgresClient: {
        async query() {},
      },
      clickHouseClient: createTestClickHouseClient(),
      templateSql,
      templateValues: {
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

    expect(peerDbQueries[0]).toBe("DROP MIRROR dofek_metric_stream_analytics");
    expect(peerDbQueries).toContainEqual(
      expect.stringContaining("CREATE MIRROR IF NOT EXISTS dofek_metric_stream_analytics"),
    );
  });

  it("drops the obsolete metric stream CDC mirror before creating current mirrors", async () => {
    const peerDbQueries: string[] = [];
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await setupClickHouseCdc({
      peerDbClient: {
        async query(queryText) {
          const query = String(queryText);
          if (query.includes("metric_stream_analytics_point_exclude_position")) {
            return {
              rows: [{ metric_stream_analytics_point_exclude_position: 1 }],
            };
          }
          if (query.includes("legacy_metric_stream_cdc_mirror_exists")) {
            return {
              rows: [{ legacy_metric_stream_cdc_mirror_exists: 1 }],
            };
          }
          if (query.includes("raw_analytics_mirror_config")) {
            return { rows: [] };
          }
          peerDbQueries.push(query);
          return {};
        },
      },
      sourcePostgresClient: {
        async query() {},
      },
      clickHouseClient: createTestClickHouseClient(),
      templateSql,
      templateValues: {
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

    const legacyMirrorDropIndex = peerDbQueries.indexOf("DROP MIRROR dofek_metric_stream_cdc");
    const currentMirrorCreateIndex = peerDbQueries.findIndex((query) =>
      query.includes("CREATE MIRROR IF NOT EXISTS dofek_sensor_priority_raw_analytics"),
    );
    expect(legacyMirrorDropIndex).toBeGreaterThanOrEqual(0);
    expect(currentMirrorCreateIndex).toBeGreaterThanOrEqual(0);
    expect(legacyMirrorDropIndex).toBeLessThan(currentMirrorCreateIndex);
  });

  it("recreates raw analytics mirrors when existing mappings are missing source tables", async () => {
    const peerDbQueries: string[] = [];
    const clickHouseCommands: string[] = [];
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await setupClickHouseCdc({
      peerDbClient: {
        async query(queryText) {
          const query = String(queryText);
          if (query.includes("metric_stream_analytics_point_exclude_position")) {
            return {
              rows: [{ metric_stream_analytics_point_exclude_position: 1 }],
            };
          }
          if (query.includes("legacy_metric_stream_cdc_mirror_exists")) {
            return { rows: [] };
          }
          if (query.includes("raw_analytics_mirror_config")) {
            return {
              rows: [
                {
                  name: "dofek_fitness_raw_analytics",
                  raw_analytics_mirror_config:
                    "activity sleep_session sleep_stage daily_metrics provider provider_priority device_priority",
                },
                {
                  name: "dofek_provider_inventory_raw_analytics",
                  raw_analytics_mirror_config:
                    "food_entry health_event lab_panel lab_result journal_entry",
                },
                {
                  name: "dofek_sensor_priority_raw_analytics",
                  raw_analytics_mirror_config: "sensor_provider_priority sensor_device_priority",
                },
              ],
            };
          }
          peerDbQueries.push(query);
          return {};
        },
      },
      sourcePostgresClient: {
        async query() {},
      },
      clickHouseClient: createTestClickHouseClient(clickHouseCommands),
      templateSql,
      templateValues: {
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

    expect(peerDbQueries[0]).toBe("DROP MIRROR dofek_fitness_raw_analytics");
    expect(peerDbQueries).not.toContain("DROP MIRROR dofek_provider_inventory_raw_analytics");
    expect(peerDbQueries).toContainEqual(
      expect.stringContaining("CREATE MIRROR IF NOT EXISTS dofek_fitness_raw_analytics"),
    );
    const truncateCommands = clickHouseCommands.filter((command) =>
      command.startsWith("TRUNCATE TABLE"),
    );
    expect(truncateCommands).toContain("TRUNCATE TABLE IF EXISTS postgres_fitness.activity");
    expect(truncateCommands).toContain("TRUNCATE TABLE IF EXISTS postgres_fitness.user_profile");
    expect(truncateCommands).not.toContain("TRUNCATE TABLE IF EXISTS postgres_fitness.food_entry");
  });

  it("recreates raw analytics mirrors when existing mappings only contain partial table-name matches", async () => {
    const peerDbQueries: string[] = [];
    const clickHouseCommands: string[] = [];
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await setupClickHouseCdc({
      peerDbClient: {
        async query(queryText) {
          const query = String(queryText);
          if (query.includes("metric_stream_analytics_point_exclude_position")) {
            return {
              rows: [{ metric_stream_analytics_point_exclude_position: 1 }],
            };
          }
          if (query.includes("legacy_metric_stream_cdc_mirror_exists")) {
            return { rows: [] };
          }
          if (query.includes("raw_analytics_mirror_config")) {
            return {
              rows: [
                {
                  name: "dofek_fitness_raw_analytics",
                  raw_analytics_mirror_config:
                    "activity sleep_session sleep_stage daily_metrics provider provider_priority device_priority user_profile_archive",
                },
              ],
            };
          }
          peerDbQueries.push(query);
          return {};
        },
      },
      sourcePostgresClient: {
        async query() {},
      },
      clickHouseClient: createTestClickHouseClient(clickHouseCommands),
      templateSql,
      templateValues: {
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

    expect(peerDbQueries[0]).toBe("DROP MIRROR dofek_fitness_raw_analytics");
    expect(clickHouseCommands).toContain("TRUNCATE TABLE IF EXISTS postgres_fitness.user_profile");
  });

  it("recreates absent raw analytics mirrors without initial copy when destination rows already exist", async () => {
    const peerDbQueries: string[] = [];
    const clickHouseCommands: string[] = [];
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await setupClickHouseCdc({
      peerDbClient: {
        async query(queryText) {
          const query = String(queryText);
          if (query.includes("metric_stream_analytics_point_exclude_position")) {
            return {
              rows: [{ metric_stream_analytics_point_exclude_position: 1 }],
            };
          }
          if (query.includes("legacy_metric_stream_cdc_mirror_exists")) {
            return { rows: [] };
          }
          if (query.includes("raw_analytics_mirror_config")) {
            return {
              rows: [
                {
                  name: "dofek_provider_inventory_raw_analytics",
                  raw_analytics_mirror_config:
                    "food_entry health_event lab_panel lab_result journal_entry",
                },
              ],
            };
          }
          peerDbQueries.push(query);
          return {};
        },
      },
      sourcePostgresClient: {
        async query() {},
      },
      clickHouseClient: createTestClickHouseClient(clickHouseCommands, 1),
      templateSql,
      templateValues: {
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

    expect(peerDbQueries).not.toContain("DROP MIRROR dofek_fitness_raw_analytics");
    expect(peerDbQueries).toContainEqual(
      expect.stringContaining("CREATE MIRROR IF NOT EXISTS dofek_fitness_raw_analytics"),
    );
    const rawFitnessMirrorQuery = peerDbQueries.find((query) =>
      query.includes("CREATE MIRROR IF NOT EXISTS dofek_fitness_raw_analytics"),
    );
    expect(rawFitnessMirrorQuery).toContain("do_initial_copy = false");
    const providerInventoryMirrorQuery = peerDbQueries.find((query) =>
      query.includes("CREATE MIRROR IF NOT EXISTS dofek_provider_inventory_raw_analytics"),
    );
    expect(providerInventoryMirrorQuery).toContain("do_initial_copy = true");
    const truncateCommands = clickHouseCommands.filter((command) =>
      command.startsWith("TRUNCATE TABLE"),
    );
    expect(truncateCommands).toEqual([]);
  });

  it("splits statements without splitting semicolons inside string literals", async () => {
    const peerDbQueries: string[] = [];

    await setupClickHouseCdc({
      peerDbClient: {
        async query(queryText) {
          if (isPeerDbMirrorReconciliationQuery(queryText)) {
            return { rows: [] };
          }
          peerDbQueries.push(queryText);
          return {};
        },
      },
      sourcePostgresClient: {
        async query() {},
      },
      clickHouseClient: createTestClickHouseClient(),
      templateSql: "first {{POSTGRES_CREDENTIAL}}; second;",
      templateValues: {
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
    expect(clickHouseClientMocks.command).not.toHaveBeenCalledWith({
      query: "CREATE DATABASE IF NOT EXISTS peerdb",
    });
    expect(clickHouseClientMocks.command).toHaveBeenCalledWith({
      query: expect.stringContaining(
        "ALTER TABLE postgres_fitness.metric_stream ADD COLUMN IF NOT EXISTS _peerdb_synced_at",
      ),
    });
    expect(clickHouseClientMocks.command).toHaveBeenCalledWith({
      query: expect.stringContaining(
        "ALTER TABLE postgres_fitness.metric_stream ADD COLUMN IF NOT EXISTS _peerdb_is_deleted",
      ),
    });
    expect(clickHouseClientMocks.command).toHaveBeenCalledWith({
      query: expect.stringContaining(
        "ALTER TABLE postgres_fitness.metric_stream ADD COLUMN IF NOT EXISTS _peerdb_version",
      ),
    });
    const peerDbQueries = peerDbClientMocks.query.mock.calls
      .map(([queryText]) => String(queryText))
      .filter((queryText) => !isPeerDbMirrorReconciliationQuery(queryText));
    expect(peerDbQueries).toHaveLength(8);
    expect(peerDbQueries[0]).toContain("peerdb_metric_stream_publication");
    expect(peerDbQueries[1]).toContain("peerdb_metric_stream_no_imu");
    expect(peerDbQueries[1]).toContain("WHERE (channel <> 'imu')");
    expect(peerDbQueries[2]).toContain("host = 'postgres.example'");
    expect(peerDbQueries[2]).toContain("port = 6543");
    expect(peerDbQueries[2]).toContain("password = 'pg''credential'");
    expect(peerDbQueries[3]).toContain("database = 'postgres_fitness'");
    expect(peerDbQueries[3]).toContain("host = 'clickhouse.example'");
    expect(peerDbQueries[3]).toContain("password = 'click\\credential'");
    expect(peerDbQueries[4]).toContain("CREATE MIRROR IF NOT EXISTS dofek_metric_stream_analytics");
    expect(peerDbQueries[4]).toContain("dofek_clickhouse_postgres_fitness");
    expect(peerDbQueries[4]).toContain(
      "exclude: [device_id, source_type, vector, point, metadata]",
    );
    expect(peerDbQueries[4]).toContain("publication_name = 'peerdb_metric_stream_no_imu'");
    expect(peerDbQueries[5]).toContain("CREATE MIRROR IF NOT EXISTS dofek_fitness_raw_analytics");
    expect(peerDbQueries[5]).toContain("dofek_clickhouse_postgres_fitness");
    expect(peerDbQueries[6]).toContain(
      "CREATE MIRROR IF NOT EXISTS dofek_provider_inventory_raw_analytics",
    );
    expect(peerDbQueries[6]).toContain("dofek_clickhouse_postgres_fitness");
    expect(peerDbQueries[7]).toContain(
      "CREATE MIRROR IF NOT EXISTS dofek_sensor_priority_raw_analytics",
    );
    expect(peerDbQueries[7]).toContain("dofek_clickhouse_postgres_fitness");
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

    const peerDbQueries = peerDbClientMocks.query.mock.calls
      .map(([queryText]) => String(queryText))
      .filter((queryText) => !isPeerDbMirrorReconciliationQuery(queryText));
    const peerDbQueryPostgres = String(peerDbQueries[2]);
    const peerDbQueryClickhousePostgresFitness = String(peerDbQueries[3]);
    expect(peerDbQueryPostgres).toContain("host = 'db'");
    expect(peerDbQueryPostgres).toContain("port = 5432");
    expect(peerDbQueryClickhousePostgresFitness).toContain("host = 'clickhouse'");
    expect(peerDbQueryClickhousePostgresFitness).toContain("port = 9000");
    expect(peerDbQueryClickhousePostgresFitness).toContain("database = 'postgres_fitness'");
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

    const peerDbQueries = peerDbClientMocks.query.mock.calls
      .map(([queryText]) => String(queryText))
      .filter((queryText) => !isPeerDbMirrorReconciliationQuery(queryText));
    const peerDbQueryPostgres = String(peerDbQueries[2]);
    const peerDbQueryClickhousePostgresFitness = String(peerDbQueries[3]);
    expect(peerDbQueryPostgres).toContain("host = 'postgres.internal'");
    expect(peerDbQueryPostgres).toContain("port = 6545");
    expect(peerDbQueryClickhousePostgresFitness).toContain("host = 'clickhouse.internal'");
    expect(peerDbQueryClickhousePostgresFitness).toContain("port = 9010");
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
