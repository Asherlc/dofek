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
  return `'${value.replaceAll("'", "''")}'`;
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

function requireUrlComponent(value: string, component: string, envName: string): string {
  if (!value) {
    throw new Error(`${envName} must include ${component} for PeerDB setup`);
  }
  return value;
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
    peerDbUrl: buildDefaultPeerDbUrl(postgresCredential),
    templatePath: process.env.PEERDB_CDC_SQL_TEMPLATE_PATH ?? "src/db/peerdb/metric-stream-cdc.sql",
    templateValues: {
      clickHouseDatabase: "peerdb",
      clickHouseCredential: decodeURIComponent(clickHouseUrl.password),
      clickHouseHost: "clickhouse",
      clickHousePort: 9000,
      clickHouseUser: decodeURIComponent(clickHouseUrl.username),
      postgresCredential: postgresPassword,
      postgresDatabase,
      postgresHost: databaseUrl.hostname,
      postgresPort: Number(databaseUrl.port || 5432),
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

export async function setupClickHouseCdc(options: SetupClickHouseCdcOptions): Promise<void> {
  await options.clickHouseClient.command({ query: "CREATE DATABASE IF NOT EXISTS peerdb" });
  const renderedSql = renderPeerDbSqlTemplate(options.templateSql, options.templateValues);
  for (const statement of splitPeerDbSqlStatements(renderedSql)) {
    await options.peerDbClient.query(statement);
  }
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
