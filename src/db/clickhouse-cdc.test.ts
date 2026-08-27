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

import {
  createPeerDbMirrorApiClient,
  type PeerDbMirrorApiClient,
  type PeerDbTableMapping,
  setupClickHouseCdc,
  setupClickHouseCdcFromEnv,
} from "./clickhouse-cdc.ts";

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
    queryText.includes("obsolete_metric_stream_mirror_name") ||
    queryText.includes("expected_mirrors(name)") ||
    queryText.includes("existing_mirror_name")
  );
}

function createTestClickHouseClient(
  commands: string[] = [],
  destinationRowCount = 0,
  queries: Array<{ query: string; format?: string }> = [],
): ClickHouseCommandClient {
  return {
    async command(options) {
      commands.push(options.query);
    },
    async query<TRow extends object>(options: { query: string; format?: string }) {
      queries.push(options);
      return {
        async json(): Promise<TRow[]> {
          return JSON.parse(`[{"row_count":${destinationRowCount}}]`);
        },
      };
    },
  };
}

function createConfiguredPeerDbMirrorApiClient(): PeerDbMirrorApiClient {
  return {
    async getMirrorStatus(mirrorName) {
      const destinationTableIdentifier =
        mirrorName === "dofek_provider_inventory_raw_analytics"
          ? "processing_flow_marker_provider_inventory"
          : "processing_flow_marker";
      return {
        currentFlowState: "STATUS_RUNNING",
        tableMappings:
          mirrorName === "dofek_sensor_priority_raw_analytics"
            ? []
            : [
                ...(mirrorName === "dofek_fitness_raw_analytics"
                  ? [
                      {
                        sourceTableIdentifier: "fitness.provider_connection",
                        destinationTableIdentifier: "provider_connection",
                        exclude: [],
                      },
                    ]
                  : []),
                {
                  sourceTableIdentifier: "fitness.processing_flow_marker",
                  destinationTableIdentifier,
                  exclude: [],
                },
              ],
      };
    },
    async listMirrors() {
      return [];
    },
    async changeMirrorState() {
      throw new Error("Configured PeerDB mirrors must not be edited");
    },
  };
}

function createExistingFitnessMirrorPeerDbClient() {
  return {
    async query(queryText: string) {
      const query = String(queryText);
      if (query.includes("obsolete_metric_stream_mirror_name")) return { rows: [] };
      if (query.includes("expected_mirrors(name)") && !query.includes("existing_mirror_name")) {
        return { rows: [{ name: "dofek_fitness_raw_analytics" }] };
      }
      if (query.includes("existing_mirror_name")) {
        return { rows: [{ existing_mirror_name: "dofek_fitness_raw_analytics" }] };
      }
      return {};
    },
  };
}

function configureExistingFitnessMirrorQuery(): void {
  const peerDbClient = createExistingFitnessMirrorPeerDbClient();
  peerDbClientMocks.query.mockImplementation((queryText) => peerDbClient.query(String(queryText)));
}

function configureFlowApiEnvironment(postgresHost: string): void {
  process.env.DATABASE_URL = credentialedUrl(
    "postgres",
    "health",
    "pg-credential",
    `${postgresHost}:5432`,
    "/fitness",
  );
  process.env.CLICKHOUSE_URL = credentialedUrl(
    "http",
    "analytics",
    "clickhouse-credential",
    "clickhouse.example:8123",
    "",
  );
  process.env.POSTGRES_PASSWORD = "peerdb fixture";
}

function peerDbStatusResponse(
  currentFlowState: string,
  tableMappings: PeerDbTableMapping[],
  error?: { errorMessage?: string; ok: false },
): Response {
  return new Response(
    JSON.stringify({
      currentFlowState,
      cdcStatus: { config: { tableMappings } },
      ...error,
    }),
  );
}

describe("PeerDB ClickHouse CDC setup", () => {
  const rawAnalyticsTables = [
    "activity",
    "sleep_session",
    "sleep_stage",
    "daily_metrics",
    "processing_flow_marker",
    "food_entry",
    "health_event",
    "lab_panel",
    "lab_result",
    "journal_entry",
    "provider",
    "provider_connection",
    "provider_priority",
    "device_priority",
    "sensor_provider_priority",
    "sensor_device_priority",
    "user_profile",
  ];

  it("lists every mirror identity and destination type through the Flow API", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            mirrors: [
              {
                destinationType: "CLICKHOUSE",
                isCdc: true,
                name: "dofek_fitness_raw_analytics",
              },
              {
                destinationType: "POSTGRES",
                isCdc: true,
                name: "unrelated_postgres_mirror",
              },
            ],
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createPeerDbMirrorApiClient("http://peerdb-flow-api:8113/v1", undefined).listMirrors(),
    ).resolves.toEqual([
      {
        destinationType: "CLICKHOUSE",
        isCdc: true,
        name: "dofek_fitness_raw_analytics",
      },
      {
        destinationType: "POSTGRES",
        isCdc: true,
        name: "unrelated_postgres_mirror",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith("http://peerdb-flow-api:8113/v1/mirrors/list", {
      headers: {},
    });
  });
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalClickHouseUrl = process.env.CLICKHOUSE_URL;
  const originalPostgresPassword = process.env.POSTGRES_PASSWORD;
  const originalPeerDbHost = process.env.PEERDB_CDC_HOST;
  const originalPeerDbPort = process.env.PEERDB_CDC_PORT;
  const originalPeerDbUiPort = process.env.PEERDB_UI_PORT;
  const originalTemplatePostgresHost = process.env.PEERDB_CDC_POSTGRES_HOST;
  const originalTemplatePostgresPort = process.env.PEERDB_CDC_POSTGRES_PORT;
  const originalTemplateClickhouseHost = process.env.PEERDB_CDC_CLICKHOUSE_HOST;
  const originalTemplateClickhousePort = process.env.PEERDB_CDC_CLICKHOUSE_PORT;
  const originalTemplatePath = process.env.PEERDB_CDC_SQL_TEMPLATE_PATH;

  beforeEach(() => {
    peerDbClientMocks.Client.mockReset().mockImplementation(
      // biome-ignore lint/complexity/useArrowFunction: Vitest invokes this mock with new.
      function peerDbClientConstructor() {
        return peerDbClientMocks;
      },
    );
    peerDbClientMocks.connect.mockReset().mockResolvedValue(undefined);
    peerDbClientMocks.end.mockReset().mockResolvedValue(undefined);
    peerDbClientMocks.query.mockReset().mockImplementation(async (queryText) => {
      if (isPeerDbMirrorReconciliationQuery(String(queryText))) {
        return { rows: [] };
      }
      return undefined;
    });
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
    delete process.env.PEERDB_UI_PORT;
    delete process.env.PEERDB_CDC_POSTGRES_HOST;
    delete process.env.PEERDB_CDC_POSTGRES_PORT;
    delete process.env.PEERDB_CDC_CLICKHOUSE_HOST;
    delete process.env.PEERDB_CDC_CLICKHOUSE_PORT;
    delete process.env.PEERDB_CDC_SQL_TEMPLATE_PATH;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
    if (originalPeerDbUiPort === undefined) {
      delete process.env.PEERDB_UI_PORT;
    } else {
      process.env.PEERDB_UI_PORT = originalPeerDbUiPort;
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
    for (const rawAnalyticsTable of rawAnalyticsTables) {
      expect(clickHouseCommands).toContain(
        `ALTER TABLE postgres_fitness.${rawAnalyticsTable} ADD COLUMN IF NOT EXISTS _peerdb_synced_at DateTime64(9) DEFAULT now()`,
      );
    }
    expect(sourcePostgresQueries).toHaveLength(1);
    expect(sourcePostgresQueries[0]).toContain("CREATE PUBLICATION");
    expect(sourcePostgresQueries[0]).toContain("ALTER PUBLICATION");
    for (const rawAnalyticsTable of rawAnalyticsTables) {
      expect(sourcePostgresQueries[0]).toContain(`('${rawAnalyticsTable}')`);
    }
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

  it("renders the checked-in raw analytics CDC template", async () => {
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

    expect(peerDbQueries).toHaveLength(5);
    expect(peerDbQueries[0]).toContain("CREATE PEER IF NOT EXISTS dofek_postgres");
    expect(peerDbQueries[1]).toContain(
      "CREATE PEER IF NOT EXISTS dofek_clickhouse_postgres_fitness",
    );
    expect(peerDbQueries[2]).toContain("CREATE MIRROR IF NOT EXISTS dofek_fitness_raw_analytics");
    expect(peerDbQueries[3]).toContain(
      "CREATE MIRROR IF NOT EXISTS dofek_provider_inventory_raw_analytics",
    );
    expect(peerDbQueries[4]).toContain(
      "CREATE MIRROR IF NOT EXISTS dofek_sensor_priority_raw_analytics",
    );
    expect(peerDbQueries[1]).toContain("database = 'postgres_fitness'");
    expect(peerDbQueries[2]).toContain("TO dofek_clickhouse_postgres_fitness");
    expect(peerDbQueries[3]).toContain("TO dofek_clickhouse_postgres_fitness");
    expect(peerDbQueries[4]).toContain("TO dofek_clickhouse_postgres_fitness");
    const rawMirrorSql = `${peerDbQueries[2]}\n${peerDbQueries[3]}\n${peerDbQueries[4]}`;
    for (const rawAnalyticsTable of rawAnalyticsTables) {
      expect(rawMirrorSql).toContain(`from: fitness.${rawAnalyticsTable}`);
      expect(rawMirrorSql).toContain(`to: ${rawAnalyticsTable}`);
    }
    expect(rawMirrorSql).toContain("max_batch_size = 100000");
    expect(rawMirrorSql).toContain("snapshot_num_rows_per_partition = 100000");
    expect(rawMirrorSql).toContain("snapshot_max_parallel_workers = 1");
    expect(rawMirrorSql).toContain("snapshot_num_tables_in_parallel = 1");
    expect(peerDbQueries.join("\n")).not.toContain("{{");
    expect(sourcePostgresQueries.join("\n")).toContain("peerdb_raw_analytics_publication");
  });

  it("does not resubmit mirrors that already exist in PeerDB", async () => {
    const peerDbQueries: string[] = [];
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await setupClickHouseCdc({
      peerDbMirrorApiClient: createConfiguredPeerDbMirrorApiClient(),
      peerDbClient: {
        async query(queryText) {
          const query = String(queryText);
          if (query.includes("obsolete_metric_stream_mirror_name")) {
            return { rows: [] };
          }
          if (query.includes("expected_mirrors(name)") && !query.includes("existing_mirror_name")) {
            return {
              rows: [
                { name: "dofek_fitness_raw_analytics" },
                { name: "dofek_provider_inventory_raw_analytics" },
                { name: "dofek_sensor_priority_raw_analytics" },
              ],
            };
          }
          if (query.includes("existing_mirror_name")) {
            return {
              rows: [
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

  it("adds missing processing markers to existing mirrors without recreating them", async () => {
    const peerDbQueries: string[] = [];
    const tableMappings = new Map<string, PeerDbTableMapping[]>([
      [
        "dofek_fitness_raw_analytics",
        [
          {
            sourceTableIdentifier: "fitness.processing_flow_marker",
            destinationTableIdentifier: "wrong_destination",
            exclude: [],
          },
          {
            sourceTableIdentifier: "fitness.wrong_source",
            destinationTableIdentifier: "processing_flow_marker",
            exclude: [],
          },
        ],
      ],
      [
        "dofek_provider_inventory_raw_analytics",
        [
          {
            sourceTableIdentifier: "fitness.processing_flow_marker",
            destinationTableIdentifier: "wrong_destination",
            exclude: [],
          },
          {
            sourceTableIdentifier: "fitness.wrong_source",
            destinationTableIdentifier: "processing_flow_marker_provider_inventory",
            exclude: [],
          },
        ],
      ],
    ]);
    const mirrorStates = new Map<string, string>([
      ["dofek_fitness_raw_analytics", "STATUS_RUNNING"],
      ["dofek_provider_inventory_raw_analytics", "STATUS_RUNNING"],
    ]);
    const getMirrorStatus = vi.fn(async (mirrorName: string) => {
      const currentFlowState = mirrorStates.get(mirrorName);
      const currentTableMappings = tableMappings.get(mirrorName);
      if (!currentFlowState || !currentTableMappings) {
        throw new Error(`Unexpected mirror ${mirrorName}`);
      }
      return { currentFlowState, tableMappings: currentTableMappings };
    });
    const changeMirrorState = vi.fn(
      async (request: Parameters<PeerDbMirrorApiClient["changeMirrorState"]>[0]) => {
        if (request.requestedFlowState === "STATUS_PAUSED") {
          mirrorStates.set(request.flowJobName, "STATUS_PAUSED");
          return;
        }
        const additionalTables =
          request.flowConfigUpdate?.cdcFlowConfigUpdate.additional_tables ?? [];
        tableMappings.set(request.flowJobName, [
          ...(tableMappings.get(request.flowJobName) ?? []),
          ...additionalTables,
        ]);
        mirrorStates.set(request.flowJobName, "STATUS_RUNNING");
      },
    );
    const peerDbMirrorApiClient: PeerDbMirrorApiClient = {
      getMirrorStatus,
      changeMirrorState,
      async listMirrors() {
        return [];
      },
    };
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await setupClickHouseCdc({
      peerDbMirrorApiClient,
      peerDbClient: {
        async query(queryText) {
          const query = String(queryText);
          if (query.includes("obsolete_metric_stream_mirror_name")) {
            return { rows: [] };
          }
          if (query.includes("expected_mirrors(name)") && !query.includes("existing_mirror_name")) {
            return {
              rows: [
                { name: "dofek_fitness_raw_analytics" },
                { name: "dofek_provider_inventory_raw_analytics" },
              ],
            };
          }
          if (query.includes("existing_mirror_name")) {
            return {
              rows: [
                { existing_mirror_name: "dofek_fitness_raw_analytics" },
                { existing_mirror_name: "dofek_provider_inventory_raw_analytics" },
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

    expect(getMirrorStatus).toHaveBeenCalledTimes(6);
    expect(peerDbMirrorApiClient.changeMirrorState).toHaveBeenCalledTimes(4);
    expect(peerDbMirrorApiClient.changeMirrorState).toHaveBeenNthCalledWith(1, {
      flowJobName: "dofek_fitness_raw_analytics",
      requestedFlowState: "STATUS_PAUSED",
    });
    expect(peerDbMirrorApiClient.changeMirrorState).toHaveBeenCalledWith({
      flowJobName: "dofek_fitness_raw_analytics",
      requestedFlowState: "STATUS_RUNNING",
      flowConfigUpdate: {
        cdcFlowConfigUpdate: {
          additional_tables: [
            {
              sourceTableIdentifier: "fitness.provider_connection",
              destinationTableIdentifier: "provider_connection",
              exclude: [],
            },
            {
              sourceTableIdentifier: "fitness.processing_flow_marker",
              destinationTableIdentifier: "processing_flow_marker",
              exclude: [],
            },
          ],
        },
      },
    });
    expect(peerDbMirrorApiClient.changeMirrorState).toHaveBeenNthCalledWith(3, {
      flowJobName: "dofek_provider_inventory_raw_analytics",
      requestedFlowState: "STATUS_PAUSED",
    });
    expect(peerDbMirrorApiClient.changeMirrorState).toHaveBeenCalledWith({
      flowJobName: "dofek_provider_inventory_raw_analytics",
      requestedFlowState: "STATUS_RUNNING",
      flowConfigUpdate: {
        cdcFlowConfigUpdate: {
          additional_tables: [
            {
              sourceTableIdentifier: "fitness.processing_flow_marker",
              destinationTableIdentifier: "processing_flow_marker_provider_inventory",
              exclude: [],
            },
          ],
        },
      },
    });
    expect(peerDbQueries.join("\n")).not.toContain("DROP MIRROR dofek_fitness_raw_analytics");
    expect(peerDbQueries.join("\n")).not.toContain(
      "DROP MIRROR dofek_provider_inventory_raw_analytics",
    );
  });

  it("fails when PeerDB managed mirror rows are malformed", async () => {
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await expect(
      setupClickHouseCdc({
        peerDbClient: {
          async query(queryText) {
            const query = String(queryText);
            if (query.includes("obsolete_metric_stream_mirror_name")) {
              return { rows: [] };
            }
            if (
              query.includes("expected_mirrors(name)") &&
              !query.includes("existing_mirror_name")
            ) {
              return { rows: [] };
            }
            if (query.includes("existing_mirror_name")) {
              return { rows: [{ existing_mirror_name: "unexpected_mirror" }] };
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
      }),
    ).rejects.toThrow("Unable to read existing PeerDB managed mirrors");
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
          if (query.includes("CREATE MIRROR IF NOT EXISTS dofek_fitness_raw_analytics")) {
            throw new Error(
              'unable to submit job: "status: AlreadyExists, message: "workflow already exists for flow: dofek_fitness_raw_analytics""',
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
      expect.stringContaining("CREATE MIRROR IF NOT EXISTS dofek_fitness_raw_analytics"),
    );
  });

  it("propagates PeerDB create mirror errors that are not existing workflow errors", async () => {
    const peerDbQueries: string[] = [];
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await expect(
      setupClickHouseCdc({
        peerDbClient: {
          async query(queryText) {
            const query = String(queryText);
            if (isPeerDbMirrorReconciliationQuery(query)) {
              return { rows: [] };
            }
            peerDbQueries.push(query);
            if (query.includes("CREATE MIRROR IF NOT EXISTS dofek_fitness_raw_analytics")) {
              throw new Error("PeerDB connection reset");
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
      }),
    ).rejects.toThrow("PeerDB connection reset");

    expect(peerDbQueries).toContainEqual(
      expect.stringContaining("CREATE MIRROR IF NOT EXISTS dofek_fitness_raw_analytics"),
    );
    expect(peerDbQueries).not.toContainEqual(
      expect.stringContaining("CREATE MIRROR IF NOT EXISTS dofek_provider_inventory_raw_analytics"),
    );
  });

  it("propagates existing workflow errors for a different mirror name", async () => {
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await expect(
      setupClickHouseCdc({
        peerDbClient: {
          async query(queryText) {
            const query = String(queryText);
            if (isPeerDbMirrorReconciliationQuery(query)) {
              return { rows: [] };
            }
            if (query.includes("CREATE MIRROR IF NOT EXISTS dofek_fitness_raw_analytics")) {
              throw new Error(
                'unable to submit job: "status: AlreadyExists, message: "workflow already exists for flow: dofek_provider_inventory_raw_analytics""',
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
      }),
    ).rejects.toThrow("workflow already exists for flow: dofek_provider_inventory_raw_analytics");
  });

  it("drops the obsolete metric stream CDC mirror before creating current mirrors", async () => {
    const peerDbQueries: string[] = [];
    let obsoleteMirrorLookupQuery: string | null = null;
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await setupClickHouseCdc({
      peerDbClient: {
        async query(queryText) {
          const query = String(queryText);
          if (query.includes("obsolete_metric_stream_mirror_name")) {
            obsoleteMirrorLookupQuery = query;
            return {
              rows: [{ obsolete_metric_stream_mirror_name: "dofek_metric_stream_cdc" }],
            };
          }
          if (query.includes("expected_mirrors(name)") && !query.includes("existing_mirror_name")) {
            return { rows: [] };
          }
          if (query.includes("existing_mirror_name")) {
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

    expect(obsoleteMirrorLookupQuery).toContain("('dofek_metric_stream_analytics')");
    expect(obsoleteMirrorLookupQuery).toContain("('dofek_metric_stream_cdc')");
    const legacyMirrorDropIndex = peerDbQueries.indexOf("DROP MIRROR dofek_metric_stream_cdc");
    const currentMirrorCreateIndex = peerDbQueries.findIndex((query) =>
      query.includes("CREATE MIRROR IF NOT EXISTS dofek_sensor_priority_raw_analytics"),
    );
    expect(legacyMirrorDropIndex).toBeGreaterThanOrEqual(0);
    expect(currentMirrorCreateIndex).toBeGreaterThanOrEqual(0);
    expect(legacyMirrorDropIndex).toBeLessThan(currentMirrorCreateIndex);
  });

  it("fails when obsolete metric stream mirror rows are malformed", async () => {
    const peerDbQueries: string[] = [];
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await expect(
      setupClickHouseCdc({
        peerDbClient: {
          async query(queryText) {
            const query = String(queryText);
            if (query.includes("obsolete_metric_stream_mirror_name")) {
              return {
                rows: [{ obsolete_metric_stream_mirror_name: null }],
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
      }),
    ).rejects.toThrow("Unable to read obsolete metric stream PeerDB mirror name");
    expect(peerDbQueries).not.toContain("DROP MIRROR null");
  });

  it("preserves existing raw analytics mirrors instead of dropping them from config text", async () => {
    const peerDbQueries: string[] = [];
    const clickHouseCommands: string[] = [];
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await setupClickHouseCdc({
      peerDbMirrorApiClient: createConfiguredPeerDbMirrorApiClient(),
      peerDbClient: {
        async query(queryText) {
          const query = String(queryText);
          if (query.includes("obsolete_metric_stream_mirror_name")) {
            return { rows: [] };
          }
          if (query.includes("expected_mirrors(name)") && !query.includes("existing_mirror_name")) {
            return {
              rows: [
                { name: "dofek_fitness_raw_analytics" },
                { name: "dofek_provider_inventory_raw_analytics" },
                { name: "dofek_sensor_priority_raw_analytics" },
              ],
            };
          }
          if (query.includes("existing_mirror_name")) {
            return {
              rows: [
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

    expect(peerDbQueries).not.toContain("DROP MIRROR dofek_fitness_raw_analytics");
    expect(peerDbQueries).not.toContain("DROP MIRROR dofek_provider_inventory_raw_analytics");
    expect(peerDbQueries).not.toContain("DROP MIRROR dofek_sensor_priority_raw_analytics");
    expect(peerDbQueries.join("\n")).not.toContain("CREATE MIRROR");
    const truncateCommands = clickHouseCommands.filter((command) =>
      command.startsWith("TRUNCATE TABLE"),
    );
    expect(truncateCommands).toEqual([]);
  });

  it("recreates absent raw analytics mirrors without initial copy when destination rows already exist", async () => {
    const peerDbQueries: string[] = [];
    const clickHouseCommands: string[] = [];
    const clickHouseQueries: Array<{ query: string; format?: string }> = [];
    const sourcePostgresQueries: string[] = [];
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await setupClickHouseCdc({
      peerDbClient: {
        async query(queryText) {
          const query = String(queryText);
          if (query.includes("obsolete_metric_stream_mirror_name")) {
            return { rows: [] };
          }
          if (query.includes("expected_mirrors(name)") && !query.includes("existing_mirror_name")) {
            return {
              rows: [
                { name: "dofek_provider_inventory_raw_analytics" },
                { name: "dofek_sensor_priority_raw_analytics" },
              ],
            };
          }
          if (query.includes("existing_mirror_name")) {
            return { rows: [] };
          }
          peerDbQueries.push(query);
          return {};
        },
      },
      sourcePostgresClient: {
        async query(queryText) {
          const query = String(queryText);
          if (query.includes("source_counts")) {
            sourcePostgresQueries.push(query);
          }
          return { rows: [{ row_count: "1" }] };
        },
      },
      clickHouseClient: createTestClickHouseClient(clickHouseCommands, 1, clickHouseQueries),
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
    expect(truncateCommands).toEqual([
      "TRUNCATE TABLE IF EXISTS postgres_fitness.food_entry",
      "TRUNCATE TABLE IF EXISTS postgres_fitness.health_event",
      "TRUNCATE TABLE IF EXISTS postgres_fitness.lab_panel",
      "TRUNCATE TABLE IF EXISTS postgres_fitness.lab_result",
      "TRUNCATE TABLE IF EXISTS postgres_fitness.journal_entry",
      "TRUNCATE TABLE IF EXISTS postgres_fitness.sensor_provider_priority",
      "TRUNCATE TABLE IF EXISTS postgres_fitness.sensor_device_priority",
    ]);
    expect(truncateCommands).not.toContain("TRUNCATE TABLE IF EXISTS postgres_fitness.activity");
    expect(sourcePostgresQueries).toHaveLength(1);
    expect(sourcePostgresQueries[0]).toContain(
      "SELECT count(*) AS row_count FROM fitness.activity",
    );
    expect(sourcePostgresQueries[0]).toContain(
      "SELECT count(*) AS row_count FROM fitness.sleep_session",
    );
    expect(sourcePostgresQueries[0]).toContain(
      "SELECT count(*) AS row_count FROM fitness.user_profile",
    );
    expect(clickHouseQueries).toHaveLength(1);
    expect(clickHouseQueries[0]).toEqual({
      query: expect.stringContaining(
        "table IN ('activity', 'sleep_session', 'sleep_stage', 'daily_metrics'",
      ),
      format: "JSONEachRow",
    });
  });

  it("reads raw analytics destination row counts with the ClickHouse client method binding", async () => {
    const peerDbQueries: string[] = [];
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");
    interface BoundClickHouseClient extends ClickHouseCommandClient {
      queryContextIsBound: boolean;
    }
    const clickHouseClient: BoundClickHouseClient = {
      queryContextIsBound: true,
      async command() {},
      async query<TRow extends object>(
        this: BoundClickHouseClient,
        _options: { query: string; format: "JSONEachRow" },
      ) {
        expect(this.queryContextIsBound).toBe(true);
        return {
          async json(): Promise<TRow[]> {
            return JSON.parse('[{"row_count":1}]');
          },
        };
      },
    };

    await setupClickHouseCdc({
      peerDbClient: {
        async query(queryText) {
          const query = String(queryText);
          if (query.includes("obsolete_metric_stream_mirror_name")) {
            return { rows: [] };
          }
          if (query.includes("expected_mirrors(name)") && !query.includes("existing_mirror_name")) {
            return {
              rows: [
                { name: "dofek_provider_inventory_raw_analytics" },
                { name: "dofek_sensor_priority_raw_analytics" },
              ],
            };
          }
          if (query.includes("existing_mirror_name")) {
            return { rows: [] };
          }
          peerDbQueries.push(query);
          return {};
        },
      },
      sourcePostgresClient: {
        async query() {
          return { rows: [{ row_count: "1" }] };
        },
      },
      clickHouseClient,
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

    const rawFitnessMirrorQuery = peerDbQueries.find((query) =>
      query.includes("CREATE MIRROR IF NOT EXISTS dofek_fitness_raw_analytics"),
    );
    expect(rawFitnessMirrorQuery).toContain("do_initial_copy = false");
  });

  it("recreates absent raw analytics mirrors with initial copy when destination rows are incomplete", async () => {
    const peerDbQueries: string[] = [];
    const clickHouseCommands: string[] = [];
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await setupClickHouseCdc({
      peerDbClient: {
        async query(queryText) {
          const query = String(queryText);
          if (query.includes("obsolete_metric_stream_mirror_name")) {
            return { rows: [] };
          }
          if (query.includes("expected_mirrors(name)") && !query.includes("existing_mirror_name")) {
            return {
              rows: [{ name: "dofek_provider_inventory_raw_analytics" }],
            };
          }
          if (query.includes("existing_mirror_name")) {
            return { rows: [] };
          }
          peerDbQueries.push(query);
          return {};
        },
      },
      sourcePostgresClient: {
        async query() {
          return { rows: [{ row_count: "2" }] };
        },
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

    const rawFitnessMirrorQuery = peerDbQueries.find((query) =>
      query.includes("CREATE MIRROR IF NOT EXISTS dofek_fitness_raw_analytics"),
    );
    expect(rawFitnessMirrorQuery).toContain("do_initial_copy = true");
    const truncateCommands = clickHouseCommands.filter((command) =>
      command.startsWith("TRUNCATE TABLE"),
    );
    expect(truncateCommands).toEqual([
      "TRUNCATE TABLE IF EXISTS postgres_fitness.activity",
      "TRUNCATE TABLE IF EXISTS postgres_fitness.sleep_session",
      "TRUNCATE TABLE IF EXISTS postgres_fitness.sleep_stage",
      "TRUNCATE TABLE IF EXISTS postgres_fitness.daily_metrics",
      "TRUNCATE TABLE IF EXISTS postgres_fitness.provider",
      "TRUNCATE TABLE IF EXISTS postgres_fitness.provider_connection",
      "TRUNCATE TABLE IF EXISTS postgres_fitness.provider_priority",
      "TRUNCATE TABLE IF EXISTS postgres_fitness.device_priority",
      "TRUNCATE TABLE IF EXISTS postgres_fitness.processing_flow_marker",
      "TRUNCATE TABLE IF EXISTS postgres_fitness.user_profile",
      "TRUNCATE TABLE IF EXISTS postgres_fitness.food_entry",
      "TRUNCATE TABLE IF EXISTS postgres_fitness.health_event",
      "TRUNCATE TABLE IF EXISTS postgres_fitness.lab_panel",
      "TRUNCATE TABLE IF EXISTS postgres_fitness.lab_result",
      "TRUNCATE TABLE IF EXISTS postgres_fitness.journal_entry",
      "TRUNCATE TABLE IF EXISTS postgres_fitness.sensor_provider_priority",
      "TRUNCATE TABLE IF EXISTS postgres_fitness.sensor_device_priority",
    ]);
  });

  it("recreates absent raw analytics mirrors with initial copy when source tables are empty", async () => {
    const peerDbQueries: string[] = [];
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await setupClickHouseCdc({
      peerDbClient: {
        async query(queryText) {
          const query = String(queryText);
          if (query.includes("obsolete_metric_stream_mirror_name")) {
            return { rows: [] };
          }
          if (query.includes("expected_mirrors(name)") && !query.includes("existing_mirror_name")) {
            return {
              rows: [
                { name: "dofek_provider_inventory_raw_analytics" },
                { name: "dofek_sensor_priority_raw_analytics" },
              ],
            };
          }
          if (query.includes("existing_mirror_name")) {
            return { rows: [] };
          }
          peerDbQueries.push(query);
          return {};
        },
      },
      sourcePostgresClient: {
        async query() {
          return { rows: [{ row_count: "0" }] };
        },
      },
      clickHouseClient: createTestClickHouseClient([], 1),
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

    const rawFitnessMirrorQuery = peerDbQueries.find((query) =>
      query.includes("CREATE MIRROR IF NOT EXISTS dofek_fitness_raw_analytics"),
    );
    expect(rawFitnessMirrorQuery).toContain("do_initial_copy = true");
  });

  it("recreates absent raw analytics mirrors with initial copy when destination tables are empty", async () => {
    const peerDbQueries: string[] = [];
    const clickHouseQueries: Array<{ query: string; format?: string }> = [];
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await setupClickHouseCdc({
      peerDbClient: {
        async query(queryText) {
          const query = String(queryText);
          if (query.includes("obsolete_metric_stream_mirror_name")) {
            return { rows: [] };
          }
          if (query.includes("expected_mirrors(name)") && !query.includes("existing_mirror_name")) {
            return {
              rows: [{ name: "dofek_provider_inventory_raw_analytics" }],
            };
          }
          if (query.includes("existing_mirror_name")) {
            return { rows: [] };
          }
          peerDbQueries.push(query);
          return {};
        },
      },
      sourcePostgresClient: {
        async query() {},
      },
      clickHouseClient: createTestClickHouseClient([], 0, clickHouseQueries),
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

    const rawFitnessMirrorQuery = peerDbQueries.find((query) =>
      query.includes("CREATE MIRROR IF NOT EXISTS dofek_fitness_raw_analytics"),
    );
    expect(rawFitnessMirrorQuery).toContain("do_initial_copy = true");
    expect(clickHouseQueries).toHaveLength(2);
    expect(clickHouseQueries[0]).toEqual({
      query: expect.stringContaining("table IN ('activity', 'sleep_session'"),
      format: "JSONEachRow",
    });
  });

  it("fails when ClickHouse raw analytics row count returns no rows", async () => {
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");
    const clickHouseClient: ClickHouseCommandClient = {
      async command() {},
      async query<TRow extends object>() {
        return {
          async json(): Promise<TRow[]> {
            return [];
          },
        };
      },
    };

    await expect(
      setupClickHouseCdc({
        peerDbClient: {
          async query(queryText) {
            const query = String(queryText);
            if (
              query.includes("expected_mirrors(name)") &&
              !query.includes("existing_mirror_name")
            ) {
              return { rows: [] };
            }
            if (isPeerDbMirrorReconciliationQuery(query)) {
              return { rows: [] };
            }
            return {};
          },
        },
        sourcePostgresClient: {
          async query() {},
        },
        clickHouseClient,
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
      }),
    ).rejects.toThrow("Unable to read ClickHouse raw analytics destination row count");
  });

  it("fails when ClickHouse raw analytics row count is null", async () => {
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");
    const clickHouseClient: ClickHouseCommandClient = {
      async command() {},
      async query<TRow extends object>() {
        return {
          async json(): Promise<TRow[]> {
            return JSON.parse('[{"row_count":null}]');
          },
        };
      },
    };

    await expect(
      setupClickHouseCdc({
        peerDbClient: {
          async query(queryText) {
            const query = String(queryText);
            if (
              query.includes("expected_mirrors(name)") &&
              !query.includes("existing_mirror_name")
            ) {
              return { rows: [] };
            }
            if (isPeerDbMirrorReconciliationQuery(query)) {
              return { rows: [] };
            }
            return {};
          },
        },
        sourcePostgresClient: {
          async query() {},
        },
        clickHouseClient,
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
      }),
    ).rejects.toThrow("Unable to read ClickHouse raw analytics destination row count");
  });

  it("fails when ClickHouse raw analytics row count has an invalid shape", async () => {
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");
    const clickHouseClient: ClickHouseCommandClient = {
      async command() {},
      async query<TRow extends object>() {
        return {
          async json(): Promise<TRow[]> {
            return JSON.parse('[{"row_count":"not-a-count"}]');
          },
        };
      },
    };

    await expect(
      setupClickHouseCdc({
        peerDbClient: {
          async query(queryText) {
            const query = String(queryText);
            if (
              query.includes("expected_mirrors(name)") &&
              !query.includes("existing_mirror_name")
            ) {
              return { rows: [] };
            }
            if (isPeerDbMirrorReconciliationQuery(query)) {
              return { rows: [] };
            }
            return {};
          },
        },
        sourcePostgresClient: {
          async query() {},
        },
        clickHouseClient,
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
      }),
    ).rejects.toThrow("Unable to read ClickHouse raw analytics destination row count");
  });

  it("fails when Postgres raw analytics source row count returns no rows", async () => {
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await expect(
      setupClickHouseCdc({
        peerDbClient: {
          async query(queryText) {
            const query = String(queryText);
            if (query.includes("obsolete_metric_stream_mirror_name")) {
              return { rows: [] };
            }
            if (
              query.includes("expected_mirrors(name)") &&
              !query.includes("existing_mirror_name")
            ) {
              return {
                rows: [
                  { name: "dofek_provider_inventory_raw_analytics" },
                  { name: "dofek_sensor_priority_raw_analytics" },
                ],
              };
            }
            if (query.includes("existing_mirror_name")) {
              return { rows: [] };
            }
            return {};
          },
        },
        sourcePostgresClient: {
          async query() {
            return { rows: [] };
          },
        },
        clickHouseClient: createTestClickHouseClient([], 1),
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
      }),
    ).rejects.toThrow("Unable to read Postgres raw analytics source row count");
  });

  it("fails when Postgres raw analytics source row count is invalid", async () => {
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await expect(
      setupClickHouseCdc({
        peerDbClient: {
          async query(queryText) {
            const query = String(queryText);
            if (query.includes("obsolete_metric_stream_mirror_name")) {
              return { rows: [] };
            }
            if (
              query.includes("expected_mirrors(name)") &&
              !query.includes("existing_mirror_name")
            ) {
              return {
                rows: [
                  { name: "dofek_provider_inventory_raw_analytics" },
                  { name: "dofek_sensor_priority_raw_analytics" },
                ],
              };
            }
            if (query.includes("existing_mirror_name")) {
              return { rows: [] };
            }
            return {};
          },
        },
        sourcePostgresClient: {
          async query() {
            return { rows: [{ row_count: null }] };
          },
        },
        clickHouseClient: createTestClickHouseClient([], 1),
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
      }),
    ).rejects.toThrow("Unable to read Postgres raw analytics source row count");
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
    const peerDbQueries = peerDbClientMocks.query.mock.calls
      .map(([queryText]) => String(queryText))
      .filter((queryText) => !isPeerDbMirrorReconciliationQuery(queryText));
    expect(peerDbQueries).toHaveLength(6);
    expect(peerDbQueries[0]).toContain("peerdb_raw_analytics_publication");
    expect(peerDbQueries[1]).toContain("host = 'postgres.example'");
    expect(peerDbQueries[1]).toContain("port = 6543");
    expect(peerDbQueries[1]).toContain("password = 'pg''credential'");
    expect(peerDbQueries[2]).toContain("database = 'postgres_fitness'");
    expect(peerDbQueries[2]).toContain("host = 'clickhouse.example'");
    expect(peerDbQueries[2]).toContain("password = 'click\\credential'");
    expect(peerDbQueries[3]).toContain("CREATE MIRROR IF NOT EXISTS dofek_fitness_raw_analytics");
    expect(peerDbQueries[3]).toContain("dofek_clickhouse_postgres_fitness");
    expect(peerDbQueries[3]).toContain("max_batch_size = 100000");
    expect(peerDbQueries[3]).toContain("snapshot_num_rows_per_partition = 100000");
    expect(peerDbQueries[3]).toContain("snapshot_max_parallel_workers = 1");
    expect(peerDbQueries[3]).toContain("snapshot_num_tables_in_parallel = 1");
    expect(peerDbQueries[4]).toContain(
      "CREATE MIRROR IF NOT EXISTS dofek_provider_inventory_raw_analytics",
    );
    expect(peerDbQueries[4]).toContain("dofek_clickhouse_postgres_fitness");
    expect(peerDbQueries[5]).toContain(
      "CREATE MIRROR IF NOT EXISTS dofek_sensor_priority_raw_analytics",
    );
    expect(peerDbQueries[5]).toContain("dofek_clickhouse_postgres_fitness");
    expect(peerDbQueries.join("\n")).not.toContain("{{");
    expect(peerDbClientMocks.end).toHaveBeenCalledTimes(2);
    expect(clickHouseClientMocks.close).toHaveBeenCalledTimes(1);
  });

  it("uses the internal PeerDB flow API to reconcile an existing mirror", async () => {
    process.env.DATABASE_URL = credentialedUrl(
      "postgres",
      "health",
      "pg-credential",
      "postgres.example:5432",
      "/fitness",
    );
    process.env.CLICKHOUSE_URL = credentialedUrl(
      "http",
      "analytics",
      "clickhouse-credential",
      "clickhouse.example:8123",
      "",
    );
    process.env.POSTGRES_PASSWORD = "peerdb fixture";
    peerDbClientMocks.query.mockImplementation(async (queryText) => {
      const query = String(queryText);
      if (query.includes("obsolete_metric_stream_mirror_name")) return { rows: [] };
      if (query.includes("expected_mirrors(name)") && !query.includes("existing_mirror_name")) {
        return { rows: [{ name: "dofek_fitness_raw_analytics" }] };
      }
      if (query.includes("existing_mirror_name")) {
        return { rows: [{ existing_mirror_name: "dofek_fitness_raw_analytics" }] };
      }
      return {};
    });
    let mirrorState = "STATUS_RUNNING";
    let hasRequiredMappings = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/mirrors/status")) {
        return new Response(
          JSON.stringify({
            currentFlowState: mirrorState,
            cdcStatus: {
              config: {
                tableMappings: hasRequiredMappings
                  ? [
                      {
                        sourceTableIdentifier: "fitness.provider_connection",
                        destinationTableIdentifier: "provider_connection",
                        exclude: [],
                      },
                      {
                        sourceTableIdentifier: "fitness.processing_flow_marker",
                        destinationTableIdentifier: "processing_flow_marker",
                        exclude: [],
                      },
                    ]
                  : [],
              },
            },
          }),
        );
      }
      const requestBody = String(init?.body);
      if (requestBody.includes('"requestedFlowState":"STATUS_PAUSED"')) {
        mirrorState = "STATUS_PAUSED";
      } else {
        hasRequiredMappings = true;
        mirrorState = "STATUS_RUNNING";
      }
      return new Response("{}");
    });
    vi.stubGlobal("fetch", fetchMock);

    await setupClickHouseCdcFromEnv();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://peerdb-flow-api:8113/v1/mirrors/status",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://peerdb-flow-api:8113/v1/mirrors/state_change",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "http://peerdb-flow-api:8113/v1/mirrors/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        flowJobName: "dofek_fitness_raw_analytics",
        includeFlowInfo: true,
      }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://peerdb-flow-api:8113/v1/mirrors/state_change",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          flowJobName: "dofek_fitness_raw_analytics",
          requestedFlowState: "STATUS_PAUSED",
        }),
      },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "http://peerdb-flow-api:8113/v1/mirrors/state_change",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          flowJobName: "dofek_fitness_raw_analytics",
          requestedFlowState: "STATUS_RUNNING",
          flowConfigUpdate: {
            cdcFlowConfigUpdate: {
              additional_tables: [
                {
                  sourceTableIdentifier: "fitness.provider_connection",
                  destinationTableIdentifier: "provider_connection",
                  exclude: [],
                },
                {
                  sourceTableIdentifier: "fitness.processing_flow_marker",
                  destinationTableIdentifier: "processing_flow_marker",
                  exclude: [],
                },
              ],
            },
          },
        }),
      },
    );
  });

  it("authenticates localhost PeerDB flow API status requests", async () => {
    configureFlowApiEnvironment("localhost");
    configureExistingFitnessMirrorQuery();
    const fetchMock = vi.fn(async () =>
      peerDbStatusResponse("STATUS_RUNNING", [
        {
          sourceTableIdentifier: "fitness.provider_connection",
          destinationTableIdentifier: "provider_connection",
          exclude: [],
        },
        {
          sourceTableIdentifier: "fitness.processing_flow_marker",
          destinationTableIdentifier: "processing_flow_marker",
          exclude: [],
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    await setupClickHouseCdcFromEnv();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:3001/api/v1/mirrors/status", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(":peerdb fixture").toString("base64")}`,
      },
      body: JSON.stringify({
        flowJobName: "dofek_fitness_raw_analytics",
        includeFlowInfo: true,
      }),
    });
  });

  it("surfaces a PeerDB flow API HTTP response body", async () => {
    configureFlowApiEnvironment("postgres.example");
    configureExistingFitnessMirrorQuery();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("flow unavailable", { status: 503, statusText: "Unavailable" }),
      ),
    );

    await expect(setupClickHouseCdcFromEnv()).rejects.toThrow(
      "PeerDB API request failed with HTTP 503: flow unavailable",
    );
  });

  it("falls back to HTTP status text when the PeerDB response body is empty", async () => {
    configureFlowApiEnvironment("postgres.example");
    configureExistingFitnessMirrorQuery();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503, statusText: "Unavailable" })),
    );

    await expect(setupClickHouseCdcFromEnv()).rejects.toThrow(
      "PeerDB API request failed with HTTP 503: Unavailable",
    );
  });

  it("surfaces a PeerDB mirror status failure", async () => {
    configureFlowApiEnvironment("postgres.example");
    configureExistingFitnessMirrorQuery();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        peerDbStatusResponse("STATUS_RUNNING", [], {
          ok: false,
          errorMessage: "mirror inspection failed",
        }),
      ),
    );

    await expect(setupClickHouseCdcFromEnv()).rejects.toThrow(
      "PeerDB could not inspect mirror dofek_fitness_raw_analytics: mirror inspection failed",
    );
  });

  it("surfaces a PeerDB mirror state-change failure", async () => {
    configureFlowApiEnvironment("postgres.example");
    configureExistingFitnessMirrorQuery();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/mirrors/status")) {
        return peerDbStatusResponse("STATUS_RUNNING", []);
      }
      return new Response(JSON.stringify({ ok: false, errorMessage: "pause failed" }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(setupClickHouseCdcFromEnv()).rejects.toThrow(
      "PeerDB could not change mirror dofek_fitness_raw_analytics: pause failed",
    );
  });

  it("requires the mirror API client before reconciling an existing mirror", async () => {
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");

    await expect(
      setupClickHouseCdc({
        peerDbClient: createExistingFitnessMirrorPeerDbClient(),
        sourcePostgresClient: { async query() {} },
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
      }),
    ).rejects.toThrow("PeerDB mirror API client is required to reconcile existing mirror mappings");
  });

  it("rejects editing a mirror that is not running", async () => {
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");
    const changeMirrorState = vi.fn(async () => undefined);

    await expect(
      setupClickHouseCdc({
        peerDbMirrorApiClient: {
          async getMirrorStatus() {
            return { currentFlowState: "STATUS_PAUSED", tableMappings: [] };
          },
          async listMirrors() {
            return [];
          },
          changeMirrorState,
        },
        peerDbClient: createExistingFitnessMirrorPeerDbClient(),
        sourcePostgresClient: { async query() {} },
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
      }),
    ).rejects.toThrow(
      "PeerDB mirror dofek_fitness_raw_analytics must be running before adding required processing marker mappings; current state is STATUS_PAUSED",
    );
    expect(changeMirrorState).not.toHaveBeenCalled();
  });

  it("requests that a mirror resume when mapping reconciliation fails after pausing", async () => {
    const templateSql = await readFile("src/db/peerdb/metric-stream-cdc.sql", "utf8");
    let statusReadCount = 0;
    const changeMirrorState = vi.fn(async () => undefined);

    await expect(
      setupClickHouseCdc({
        peerDbMirrorApiClient: {
          async getMirrorStatus() {
            statusReadCount += 1;
            if (statusReadCount === 1) {
              return { currentFlowState: "STATUS_RUNNING", tableMappings: [] };
            }
            throw new Error("PeerDB status unavailable");
          },
          async listMirrors() {
            return [];
          },
          changeMirrorState,
        },
        peerDbClient: createExistingFitnessMirrorPeerDbClient(),
        sourcePostgresClient: { async query() {} },
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
      }),
    ).rejects.toThrow("PeerDB status unavailable");

    expect(changeMirrorState).toHaveBeenNthCalledWith(1, {
      flowJobName: "dofek_fitness_raw_analytics",
      requestedFlowState: "STATUS_PAUSED",
    });
    expect(changeMirrorState).toHaveBeenNthCalledWith(2, {
      flowJobName: "dofek_fitness_raw_analytics",
      requestedFlowState: "STATUS_RUNNING",
    });
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
    const peerDbQueryPostgres = String(peerDbQueries[1]);
    const peerDbQueryClickhousePostgresFitness = String(peerDbQueries[2]);
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
    const peerDbQueryPostgres = String(peerDbQueries[1]);
    const peerDbQueryClickhousePostgresFitness = String(peerDbQueries[2]);
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
