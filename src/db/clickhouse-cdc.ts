import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { type ClickHouseCommandClient, createClickHouseClientFromEnv } from "./clickhouse.ts";

interface PeerDbClient {
  query(queryText: string): Promise<unknown>;
}

interface SourcePostgresClient {
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
  sourcePostgresClient: SourcePostgresClient;
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
  return `'${value.replaceAll("'", "''")}'`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

function buildDefaultPeerDbUrl(credential: string, host: string, port: number): string {
  const peerDbUrl = new URL("postgres://peerdb:9900/peerdb");
  peerDbUrl.hostname = host;
  peerDbUrl.port = String(port);
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

function parseTcpPort(rawPort: string, variableName: string): number {
  if (!/^\d+$/.test(rawPort)) {
    throw new Error(`${variableName} must be a valid TCP port`);
  }

  const port = Number.parseInt(rawPort, 10);
  if (port <= 0 || port > 65_535) {
    throw new Error(`${variableName} must be a valid TCP port`);
  }
  return port;
}

function requireUrlComponent(value: string, component: string, envName: string): string {
  if (!value) {
    throw new Error(`${envName} must include ${component} for PeerDB setup`);
  }
  return value;
}

function resolveTemplatePort(envName: string, defaultPort: number): number {
  const rawPort = process.env[envName];
  if (rawPort === undefined) {
    return defaultPort;
  }
  return parseTcpPort(rawPort, `${envName}`);
}

function resolveTemplatePortFromSourceHost(
  envName: string,
  sourceHost: string,
  sourcePort: number,
  fallbackPortForLocalhostSource: number,
): number {
  if (process.env[envName] === undefined) {
    if (isLocalhost(sourceHost)) {
      return fallbackPortForLocalhostSource;
    }
    return sourcePort;
  }

  return parseTcpPort(process.env[envName], envName);
}

function isLocalhost(host: string): boolean {
  const normalizedHost = host.toLowerCase();
  return (
    normalizedHost === "localhost" || normalizedHost === "127.0.0.1" || normalizedHost === "::1"
  );
}

function resolveTemplateHost(envName: string, sourceHost: string, fallbackHost: string): string {
  const overrideHost = process.env[envName];
  if (overrideHost !== undefined) {
    const trimmedOverrideHost = overrideHost.trim();
    if (!trimmedOverrideHost) {
      throw new Error(`${envName} must be a non-empty host`);
    }
    return trimmedOverrideHost;
  }

  if (isLocalhost(sourceHost)) {
    return fallbackHost;
  }

  return sourceHost;
}

function resolvePeerDbHost(): string {
  const peerDbHostOverride = process.env.PEERDB_CDC_HOST;
  if (peerDbHostOverride === undefined) {
    return "peerdb";
  }

  const trimmedPeerDbHostOverride = peerDbHostOverride.trim();
  if (!trimmedPeerDbHostOverride) {
    throw new Error("PEERDB_CDC_HOST must be a non-empty host");
  }

  return trimmedPeerDbHostOverride;
}

function resolvePeerDbPort(): number {
  return resolveTemplatePort("PEERDB_CDC_PORT", 9900);
}

function buildRuntimeConfig(): RuntimeConfig {
  const databaseUrl = new URL(requireEnv("DATABASE_URL"));
  const clickHouseUrl = parseClickHouseUrl(requireEnv("CLICKHOUSE_URL"));
  const postgresCredential = requireEnv("POSTGRES_PASSWORD");
  const postgresDatabase = requireUrlComponent(
    databaseUrl.pathname.replace(/^\//, ""),
    "database name",
    "DATABASE_URL",
  );
  const postgresUser = decodeURIComponent(
    requireUrlComponent(databaseUrl.username, "username", "DATABASE_URL"),
  );
  const postgresPassword = decodeURIComponent(
    requireUrlComponent(databaseUrl.password, "password", "DATABASE_URL"),
  );

  return {
    peerDbUrl: buildDefaultPeerDbUrl(postgresCredential, resolvePeerDbHost(), resolvePeerDbPort()),
    templatePath: process.env.PEERDB_CDC_SQL_TEMPLATE_PATH ?? "src/db/peerdb/metric-stream-cdc.sql",
    templateValues: {
      clickHouseDatabase: "peerdb",
      clickHouseCredential: decodeURIComponent(clickHouseUrl.password),
      clickHouseHost: resolveTemplateHost(
        "PEERDB_CDC_CLICKHOUSE_HOST",
        clickHouseUrl.hostname,
        "clickhouse",
      ),
      clickHousePort: resolveTemplatePort("PEERDB_CDC_CLICKHOUSE_PORT", 9000),
      clickHouseUser: decodeURIComponent(clickHouseUrl.username),
      postgresCredential: postgresPassword,
      postgresDatabase,
      postgresHost: resolveTemplateHost("PEERDB_CDC_POSTGRES_HOST", databaseUrl.hostname, "db"),
      postgresPort: resolveTemplatePortFromSourceHost(
        "PEERDB_CDC_POSTGRES_PORT",
        databaseUrl.hostname,
        Number(databaseUrl.port || 5432),
        5432,
      ),
      postgresUser,
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
    POSTGRES_PORT: String(values.postgresPort),
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

function splitPeerDbSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let currentStatement = "";
  let inSingleQuotedString = false;

  for (let characterIndex = 0; characterIndex < sql.length; characterIndex += 1) {
    const character = sql[characterIndex];
    const nextCharacter = sql[characterIndex + 1];

    if (character === "'") {
      currentStatement += character;
      if (inSingleQuotedString && nextCharacter === "'") {
        currentStatement += nextCharacter;
        characterIndex += 1;
      } else {
        inSingleQuotedString = !inSingleQuotedString;
      }
      continue;
    }

    if (character === ";" && !inSingleQuotedString) {
      const statement = currentStatement.trim();
      if (statement) {
        statements.push(statement);
      }
      currentStatement = "";
      continue;
    }

    currentStatement += character;
  }

  const finalStatement = currentStatement.trim();
  if (finalStatement) {
    statements.push(finalStatement);
  }

  return statements;
}

async function ensureMetricStreamPublication(client: SourcePostgresClient): Promise<void> {
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_publication
        WHERE pubname = 'peerdb_metric_stream_publication'
      ) THEN
        CREATE PUBLICATION peerdb_metric_stream_publication FOR TABLE fitness.metric_stream;
      ELSIF NOT EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'peerdb_metric_stream_publication'
          AND schemaname = 'fitness'
          AND tablename = 'metric_stream'
      ) THEN
        ALTER PUBLICATION peerdb_metric_stream_publication ADD TABLE fitness.metric_stream;
      END IF;
    END
    $$;
  `);
}

export async function setupClickHouseCdc(options: SetupClickHouseCdcOptions): Promise<void> {
  await options.clickHouseClient.command({ query: "CREATE DATABASE IF NOT EXISTS peerdb" });
  await ensureMetricStreamPublication(options.sourcePostgresClient);
  const renderedSql = renderPeerDbSqlTemplate(options.templateSql, options.templateValues);
  for (const statement of splitPeerDbSqlStatements(renderedSql)) {
    await options.peerDbClient.query(statement);
  }
}

export async function setupClickHouseCdcFromEnv(): Promise<void> {
  const config = buildRuntimeConfig();
  const peerDbClient = new Client({ connectionString: config.peerDbUrl });
  const sourcePostgresClient = new Client({ connectionString: requireEnv("DATABASE_URL") });
  const clickHouseClient = createClickHouseClientFromEnv();
  const templateSql = await readFile(config.templatePath, "utf8");

  try {
    await peerDbClient.connect();
    await sourcePostgresClient.connect();
    await setupClickHouseCdc({
      peerDbClient,
      sourcePostgresClient,
      clickHouseClient,
      templateSql,
      templateValues: config.templateValues,
    });
  } finally {
    await peerDbClient.end();
    await sourcePostgresClient.end();
    await clickHouseClient.close?.();
  }
}
