import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { type ClickHouseCommandClient, createClickHouseClientFromEnv } from "./clickhouse.ts";

interface PeerDbClient {
  query(queryText: string): Promise<unknown>;
}

export interface PeerDbSqlTemplateValues {
  clickHouseDatabase: string;
  clickHouseCredential: string;
  clickHouseHost: string;
  clickHousePort: number;
  clickHouseUser: string;
  postgresCredential: string;
  postgresDatabase: string;
  postgresHost: string;
  postgresPort: number;
  postgresUser: string;
}

interface SetupClickHouseCdcOptions {
  peerDbClient: PeerDbClient;
  clickHouseClient: ClickHouseCommandClient;
  templateSql: string;
  templateValues: PeerDbSqlTemplateValues;
}

interface RuntimeConfig {
  peerDbUrl: string;
  templatePath: string;
  templateValues: PeerDbSqlTemplateValues;
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

function buildDefaultPeerDbUrl(credential: string): string {
  const peerDbUrl = new URL("postgres://peerdb:9900/peerdb");
  peerDbUrl.username = "peerdb";
  peerDbUrl.password = credential;
  return peerDbUrl.toString();
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
  const postgresCredential = requireEnv("POSTGRES_PASSWORD");

  return {
    peerDbUrl: buildDefaultPeerDbUrl(postgresCredential),
    templatePath: process.env.PEERDB_CDC_SQL_TEMPLATE_PATH ?? "src/db/peerdb/metric-stream-cdc.sql",
    templateValues: {
      clickHouseDatabase: "peerdb",
      clickHouseCredential: decodeURIComponent(clickHouseUrl.password),
      clickHouseHost: "clickhouse",
      clickHousePort: 9000,
      clickHouseUser: decodeURIComponent(clickHouseUrl.username),
      postgresCredential: decodeURIComponent(databaseUrl.password),
      postgresDatabase: databaseUrl.pathname.replace(/^\//, ""),
      postgresHost: databaseUrl.hostname,
      postgresPort: Number(databaseUrl.port || 5432),
      postgresUser: decodeURIComponent(databaseUrl.username),
    },
  };
}

function buildTemplateReplacements(values: PeerDbSqlTemplateValues): Record<string, string> {
  return {
    CLICKHOUSE_DATABASE: peerDbStringLiteral(values.clickHouseDatabase),
    CLICKHOUSE_CREDENTIAL: peerDbStringLiteral(values.clickHouseCredential),
    CLICKHOUSE_HOST: peerDbStringLiteral(values.clickHouseHost),
    CLICKHOUSE_PORT: String(values.clickHousePort),
    CLICKHOUSE_USER: peerDbStringLiteral(values.clickHouseUser),
    POSTGRES_CREDENTIAL: peerDbStringLiteral(values.postgresCredential),
    POSTGRES_DATABASE: peerDbStringLiteral(values.postgresDatabase),
    POSTGRES_HOST: peerDbStringLiteral(values.postgresHost),
    POSTGRES_PORT: peerDbStringLiteral(String(values.postgresPort)),
    POSTGRES_USER: peerDbStringLiteral(values.postgresUser),
  };
}

function renderPeerDbSqlTemplate(templateSql: string, values: PeerDbSqlTemplateValues): string {
  const replacements = buildTemplateReplacements(values);
  return templateSql.replaceAll(/\{\{([A-Z0-9_]+)\}\}/g, (_match, placeholderName: string) => {
    const replacement = replacements[placeholderName];
    if (replacement === undefined) {
      throw new Error(`Unknown PeerDB SQL template placeholder: ${placeholderName}`);
    }
    return replacement;
  });
}

export async function setupClickHouseCdc(options: SetupClickHouseCdcOptions): Promise<void> {
  await options.clickHouseClient.command({ query: "CREATE DATABASE IF NOT EXISTS peerdb" });
  await options.peerDbClient.query(
    renderPeerDbSqlTemplate(options.templateSql, options.templateValues),
  );
}

export async function setupClickHouseCdcFromEnv(): Promise<void> {
  const config = buildRuntimeConfig();
  const peerDbClient = new Client({ connectionString: config.peerDbUrl });
  const clickHouseClient = createClickHouseClientFromEnv();
  const templateSql = await readFile(config.templatePath, "utf8");

  try {
    await peerDbClient.connect();
    await setupClickHouseCdc({
      peerDbClient,
      clickHouseClient,
      templateSql,
      templateValues: config.templateValues,
    });
  } finally {
    await peerDbClient.end();
    await clickHouseClient.close?.();
  }
}
