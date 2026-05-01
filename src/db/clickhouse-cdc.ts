import { Client } from "pg";
import { type ClickHouseCommandClient, createClickHouseClientFromEnv } from "./clickhouse.ts";

export interface PostgresPeerConfig {
  peerName: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface ClickHousePeerConfig {
  peerName: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface MetricStreamMirrorConfig {
  mirrorName: string;
  sourcePeerName: string;
  destinationPeerName: string;
  publicationName: string;
}

interface PeerDbClient {
  query(queryText: string): Promise<unknown>;
}

interface SetupClickHouseCdcOptions {
  peerDbClient: PeerDbClient;
  clickHouseClient: ClickHouseCommandClient;
  postgresPeer: PostgresPeerConfig;
  clickHousePeer: ClickHousePeerConfig;
  mirror: MetricStreamMirrorConfig;
}

interface RuntimeConfig {
  peerDbUrl: string;
  postgresPeer: PostgresPeerConfig;
  clickHousePeer: ClickHousePeerConfig;
  mirror: MetricStreamMirrorConfig;
}

function peerDbStringLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

function buildDefaultPeerDbUrl(password: string): string {
  return `postgres://peerdb:${encodeURIComponent(password)}@peerdb:9900/peerdb`;
}

function parseClickHouseUrl(urlString: string): URL {
  const url = new URL(urlString);
  if (!url.username) {
    throw new Error("CLICKHOUSE_URL must include a username for PeerDB setup");
  }
  if (!url.password) {
    throw new Error("CLICKHOUSE_URL must include a password for PeerDB setup");
  }
  return url;
}

function buildRuntimeConfig(): RuntimeConfig {
  const databaseUrl = new URL(requireEnv("DATABASE_URL"));
  const clickHouseUrl = parseClickHouseUrl(requireEnv("CLICKHOUSE_URL"));
  const postgresPassword = requireEnv("POSTGRES_PASSWORD");

  return {
    peerDbUrl: buildDefaultPeerDbUrl(postgresPassword),
    postgresPeer: {
      peerName: "dofek_postgres",
      host: databaseUrl.hostname,
      port: Number(databaseUrl.port || 5432),
      user: decodeURIComponent(databaseUrl.username),
      password: decodeURIComponent(databaseUrl.password),
      database: databaseUrl.pathname.replace(/^\//, ""),
    },
    clickHousePeer: {
      peerName: "dofek_clickhouse",
      host: "clickhouse",
      port: 9000,
      user: decodeURIComponent(clickHouseUrl.username),
      password: decodeURIComponent(clickHouseUrl.password),
      database: "peerdb",
    },
    mirror: {
      mirrorName: "dofek_metric_stream_cdc",
      sourcePeerName: "dofek_postgres",
      destinationPeerName: "dofek_clickhouse",
      publicationName: "peerdb_metric_stream_publication",
    },
  };
}

export function buildPostgresPeerStatement(config: PostgresPeerConfig): string {
  return `CREATE PEER IF NOT EXISTS ${config.peerName} FROM POSTGRES WITH
(
  host = ${peerDbStringLiteral(config.host)},
  port = ${peerDbStringLiteral(String(config.port))},
  user = ${peerDbStringLiteral(config.user)},
  password = ${peerDbStringLiteral(config.password)},
  database = ${peerDbStringLiteral(config.database)}
)`;
}

export function buildClickHousePeerStatement(config: ClickHousePeerConfig): string {
  return `CREATE PEER IF NOT EXISTS ${config.peerName} FROM CLICKHOUSE WITH
(
  host = ${peerDbStringLiteral(config.host)},
  port = ${config.port},
  user = ${peerDbStringLiteral(config.user)},
  password = ${peerDbStringLiteral(config.password)},
  database = ${peerDbStringLiteral(config.database)},
  disable_tls = true
)`;
}

export function buildMetricStreamMirrorStatement(config: MetricStreamMirrorConfig): string {
  return `CREATE MIRROR IF NOT EXISTS ${config.mirrorName}
FROM ${config.sourcePeerName} TO ${config.destinationPeerName}
WITH TABLE MAPPING
(
  {
    from: fitness.metric_stream,
    to: metric_stream,
    exclude: [device_id, source_type, vector]
  }
)
WITH (
  do_initial_copy = true,
  max_batch_size = 1000000,
  sync_interval = 60,
  publication_name = ${peerDbStringLiteral(config.publicationName)},
  soft_delete = true
)`;
}

export async function setupClickHouseCdc(options: SetupClickHouseCdcOptions): Promise<void> {
  await options.clickHouseClient.command({ query: "CREATE DATABASE IF NOT EXISTS peerdb" });
  await options.peerDbClient.query(buildPostgresPeerStatement(options.postgresPeer));
  await options.peerDbClient.query(buildClickHousePeerStatement(options.clickHousePeer));
  await options.peerDbClient.query(buildMetricStreamMirrorStatement(options.mirror));
}

export async function setupClickHouseCdcFromEnv(): Promise<void> {
  const config = buildRuntimeConfig();
  const peerDbClient = new Client({ connectionString: config.peerDbUrl });
  const clickHouseClient = createClickHouseClientFromEnv();

  try {
    await peerDbClient.connect();
    await setupClickHouseCdc({
      peerDbClient,
      clickHouseClient,
      postgresPeer: config.postgresPeer,
      clickHousePeer: config.clickHousePeer,
      mirror: config.mirror,
    });
  } finally {
    await peerDbClient.end();
    await clickHouseClient.close?.();
  }
}
