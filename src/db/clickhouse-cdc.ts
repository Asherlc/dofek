import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { z } from "zod";
import { type ClickHouseCommandClient, createClickHouseClientFromEnv } from "./clickhouse.ts";

interface PeerDbClient {
  query(queryText: string): Promise<unknown>;
}

interface SourcePostgresClient {
  query(queryText: string): Promise<unknown>;
}

export interface PeerDbSqlTemplateValues {
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

interface RawAnalyticsInitialCopyValues {
  dofek_fitness_raw_analytics: boolean;
  dofek_provider_inventory_raw_analytics: boolean;
  dofek_sensor_priority_raw_analytics: boolean;
}

interface ClickHouseRowCount {
  row_count: number | string | null;
}

const clickHouseRowCountRowsSchema = z.array(
  z.object({
    row_count: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/), z.null()]),
  }),
);

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

const analyticsPublicationName = "peerdb_raw_analytics_publication";
const analyticsSourceTables = [
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
] as const;
const rawAnalyticsMirrorNames = [
  "dofek_fitness_raw_analytics",
  "dofek_provider_inventory_raw_analytics",
  "dofek_sensor_priority_raw_analytics",
] as const;
const managedMirrorNames = rawAnalyticsMirrorNames;
const existingManagedMirrorQueryResultSchema = z.object({
  rows: z.array(
    z.object({
      existing_mirror_name: z.enum(managedMirrorNames),
    }),
  ),
});
const rawAnalyticsMirrorTableMappings: Record<
  (typeof rawAnalyticsMirrorNames)[number],
  readonly string[]
> = {
  dofek_fitness_raw_analytics: [
    "activity",
    "sleep_session",
    "sleep_stage",
    "daily_metrics",
    "provider",
    "provider_priority",
    "device_priority",
    "user_profile",
  ],
  dofek_provider_inventory_raw_analytics: [
    "food_entry",
    "health_event",
    "lab_panel",
    "lab_result",
    "journal_entry",
  ],
  dofek_sensor_priority_raw_analytics: ["sensor_provider_priority", "sensor_device_priority"],
};
const defaultRawAnalyticsInitialCopyValues: RawAnalyticsInitialCopyValues = {
  dofek_fitness_raw_analytics: true,
  dofek_provider_inventory_raw_analytics: true,
  dofek_sensor_priority_raw_analytics: true,
};
const peerDbMetadataColumns = [
  "_peerdb_synced_at DateTime64(9) DEFAULT now()",
  "_peerdb_is_deleted Int8 DEFAULT 0",
  "_peerdb_version Int64 DEFAULT 0",
] as const;
const obsoleteMetricStreamMirrorNames = [
  "dofek_metric_stream_analytics",
  "dofek_metric_stream_cdc",
] as const;

function readQueryRows(queryResult: unknown): Array<Record<string, unknown>> {
  if (typeof queryResult !== "object" || queryResult === null || !("rows" in queryResult)) {
    return [];
  }

  const rows = queryResult.rows;
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.filter(
    (row): row is Record<string, unknown> => typeof row === "object" && row !== null,
  );
}

function readInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  return null;
}

function readString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  return null;
}

function readErrorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error !== "object" || error === null || !("message" in error)) {
    return null;
  }

  const message = error.message;
  return typeof message === "string" ? message : null;
}

function readMirrorConfigTokens(mirrorConfig: string): Set<string> {
  return new Set(mirrorConfig.split(/[^A-Za-z0-9_]+/).filter((token) => token.length > 0));
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

function buildTemplateReplacements(
  values: PeerDbSqlTemplateValues,
  rawAnalyticsInitialCopyValues: RawAnalyticsInitialCopyValues,
): Record<string, string> {
  return {
    CLICKHOUSE_CREDENTIAL: peerDbStringLiteral(values.clickHouseCredential),
    CLICKHOUSE_HOST: peerDbStringLiteral(values.clickHouseHost),
    CLICKHOUSE_PORT: String(values.clickHousePort),
    CLICKHOUSE_USER: peerDbStringLiteral(values.clickHouseUser),
    FITNESS_RAW_ANALYTICS_DO_INITIAL_COPY: String(
      rawAnalyticsInitialCopyValues.dofek_fitness_raw_analytics,
    ),
    PROVIDER_INVENTORY_RAW_ANALYTICS_DO_INITIAL_COPY: String(
      rawAnalyticsInitialCopyValues.dofek_provider_inventory_raw_analytics,
    ),
    SENSOR_PRIORITY_RAW_ANALYTICS_DO_INITIAL_COPY: String(
      rawAnalyticsInitialCopyValues.dofek_sensor_priority_raw_analytics,
    ),
    POSTGRES_CREDENTIAL: peerDbStringLiteral(values.postgresCredential),
    POSTGRES_DATABASE: peerDbStringLiteral(values.postgresDatabase),
    POSTGRES_HOST: peerDbStringLiteral(values.postgresHost),
    POSTGRES_PORT: String(values.postgresPort),
    POSTGRES_USER: peerDbStringLiteral(values.postgresUser),
  };
}

function renderPeerDbSqlTemplate(
  templateSql: string,
  values: PeerDbSqlTemplateValues,
  rawAnalyticsInitialCopyValues: RawAnalyticsInitialCopyValues = defaultRawAnalyticsInitialCopyValues,
): string {
  const replacements = buildTemplateReplacements(values, rawAnalyticsInitialCopyValues);
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

function readCreateMirrorName(statement: string): string | null {
  const createMirrorMatch = statement.match(
    /\bCREATE\s+MIRROR\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/i,
  );
  return createMirrorMatch?.[1] ?? null;
}

function isExistingMirrorWorkflowError(error: unknown, mirrorName: string): boolean {
  const message = readErrorMessage(error);
  return (
    message?.includes("AlreadyExists") === true &&
    message.includes(`workflow already exists for flow: ${mirrorName}`)
  );
}

async function readExistingManagedMirrorNames(peerDbClient: PeerDbClient): Promise<Set<string>> {
  const mirrorNameRows = managedMirrorNames.map((mirrorName) => `('${mirrorName}')`).join(", ");
  const result = await peerDbClient.query(`
    SELECT flows.name AS existing_mirror_name
    FROM public.flows
    JOIN (VALUES ${mirrorNameRows}) AS expected_mirrors(name)
      ON expected_mirrors.name = flows.name
  `);

  const existingMirrorRows = existingManagedMirrorQueryResultSchema.safeParse(result);
  if (!existingMirrorRows.success) {
    throw new Error("Unable to read existing PeerDB managed mirrors");
  }

  return new Set(existingMirrorRows.data.rows.map((row) => row.existing_mirror_name));
}

async function ensureAnalyticsPublication(client: SourcePostgresClient): Promise<void> {
  const publicationTables = analyticsSourceTables
    .map((tableName) => `fitness.${tableName}`)
    .join(", ");
  const tableValueRows = analyticsSourceTables.map((tableName) => `('${tableName}')`).join(", ");

  await client.query(`
    DO $$
    DECLARE
      analytics_table_name text;
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_publication
        WHERE pubname = '${analyticsPublicationName}'
      ) THEN
        CREATE PUBLICATION ${analyticsPublicationName} FOR TABLE ${publicationTables};
      END IF;

      FOR analytics_table_name IN
        SELECT table_name
        FROM (VALUES ${tableValueRows}) AS mirrored_tables(table_name)
      LOOP
        IF NOT EXISTS (
          SELECT 1
          FROM pg_publication_tables
          WHERE pubname = '${analyticsPublicationName}'
            AND schemaname = 'fitness'
            AND tablename = analytics_table_name
        ) THEN
          EXECUTE format(
            'ALTER PUBLICATION ${analyticsPublicationName} ADD TABLE fitness.%I',
            analytics_table_name
          );
        END IF;
      END LOOP;
    END
    $$;
  `);
}

async function ensureAnalyticsPeerDbColumns(client: ClickHouseCommandClient): Promise<void> {
  for (const tableName of analyticsSourceTables) {
    for (const metadataColumn of peerDbMetadataColumns) {
      await client.command({
        query: `ALTER TABLE postgres_fitness.${tableName} ADD COLUMN IF NOT EXISTS ${metadataColumn}`,
      });
    }
  }
}

async function dropObsoleteMetricStreamPeerDbMirrors(peerDbClient: PeerDbClient): Promise<void> {
  const obsoleteMirrorRows = obsoleteMetricStreamMirrorNames
    .map((mirrorName) => `(${peerDbStringLiteral(mirrorName)})`)
    .join(", ");
  const result = await peerDbClient.query(`
    SELECT flows.name AS obsolete_metric_stream_mirror_name
    FROM public.flows
    JOIN (VALUES ${obsoleteMirrorRows}) AS obsolete_mirrors(name)
      ON obsolete_mirrors.name = flows.name
  `);

  for (const mirrorRow of readQueryRows(result)) {
    const mirrorName = mirrorRow.obsolete_metric_stream_mirror_name;
    if (typeof mirrorName !== "string") {
      throw new Error("Unable to read obsolete metric stream PeerDB mirror name");
    }
    await peerDbClient.query(`DROP MIRROR ${mirrorName}`);
  }
}

async function truncateClickHouseDestinationTables(
  clickHouseClient: ClickHouseCommandClient,
  tableNames: readonly string[],
): Promise<void> {
  await Promise.all(
    tableNames.map((tableName) =>
      clickHouseClient.command({
        query: `TRUNCATE TABLE IF EXISTS postgres_fitness.${tableName}`,
      }),
    ),
  );
}

async function clickHouseDestinationTablesHaveRows(
  clickHouseClient: ClickHouseCommandClient,
  tableNames: readonly string[],
): Promise<boolean> {
  if (!clickHouseClient.query) {
    throw new Error("ClickHouse raw analytics mirror reconciliation requires query support");
  }

  const tableNameList = tableNames.map(peerDbStringLiteral).join(", ");
  const result = await clickHouseClient.query<ClickHouseRowCount>({
    query: `
      SELECT coalesce(sum(rows), 0) AS row_count
      FROM system.parts
      WHERE database = 'postgres_fitness'
        AND table IN (${tableNameList})
        AND active = 1
    `,
    format: "JSONEachRow",
  });
  const parsedRows = clickHouseRowCountRowsSchema.safeParse(await result.json());
  if (!parsedRows.success) {
    throw new Error("Unable to read ClickHouse raw analytics destination row count");
  }

  const rows = parsedRows.data;
  if (rows.length === 0) {
    throw new Error("Unable to read ClickHouse raw analytics destination row count");
  }

  const rowCount = readInteger(rows[0]?.row_count);
  if (rowCount === null) {
    throw new Error("Unable to read ClickHouse raw analytics destination row count");
  }
  return rowCount > 0;
}

async function reconcileRawAnalyticsMirrors(
  peerDbClient: PeerDbClient,
  clickHouseClient: ClickHouseCommandClient,
): Promise<RawAnalyticsInitialCopyValues> {
  const rawAnalyticsInitialCopyValues = { ...defaultRawAnalyticsInitialCopyValues };
  const mirrorNameRows = rawAnalyticsMirrorNames
    .map((mirrorName) => `('${mirrorName}')`)
    .join(", ");
  const result = await peerDbClient.query(`
    SELECT flows.name, encode(flows.config_proto, 'escape') AS raw_analytics_mirror_config
    FROM public.flows
    JOIN (VALUES ${mirrorNameRows}) AS expected_mirrors(name)
      ON expected_mirrors.name = flows.name
  `);
  const mirrorRows = readQueryRows(result);

  for (const mirrorName of rawAnalyticsMirrorNames) {
    const tableNames = rawAnalyticsMirrorTableMappings[mirrorName];
    const mirrorRow = mirrorRows.find((row) => row.name === mirrorName);
    if (!mirrorRow) {
      if (await clickHouseDestinationTablesHaveRows(clickHouseClient, tableNames)) {
        rawAnalyticsInitialCopyValues[mirrorName] = false;
      }
      continue;
    }

    const mirrorConfig = readString(mirrorRow.raw_analytics_mirror_config);
    if (mirrorConfig === null) {
      throw new Error(`Unable to read PeerDB raw analytics mirror configuration for ${mirrorName}`);
    }

    const mirrorConfigTokens = readMirrorConfigTokens(mirrorConfig);
    if (
      !mirrorConfigTokens.has(analyticsPublicationName) ||
      tableNames.some((tableName) => !mirrorConfigTokens.has(tableName))
    ) {
      await peerDbClient.query(`DROP MIRROR ${mirrorName}`);
      await truncateClickHouseDestinationTables(clickHouseClient, tableNames);
    }
  }

  return rawAnalyticsInitialCopyValues;
}

export async function setupClickHouseCdc(options: SetupClickHouseCdcOptions): Promise<void> {
  await ensureAnalyticsPeerDbColumns(options.clickHouseClient);
  await ensureAnalyticsPublication(options.sourcePostgresClient);
  await dropObsoleteMetricStreamPeerDbMirrors(options.peerDbClient);
  const rawAnalyticsInitialCopyValues = await reconcileRawAnalyticsMirrors(
    options.peerDbClient,
    options.clickHouseClient,
  );
  const renderedSql = renderPeerDbSqlTemplate(
    options.templateSql,
    options.templateValues,
    rawAnalyticsInitialCopyValues,
  );
  const existingMirrorNames = await readExistingManagedMirrorNames(options.peerDbClient);
  for (const statement of splitPeerDbSqlStatements(renderedSql)) {
    const mirrorName = readCreateMirrorName(statement);
    if (mirrorName !== null && existingMirrorNames.has(mirrorName)) {
      continue;
    }
    try {
      await options.peerDbClient.query(statement);
    } catch (error) {
      if (mirrorName !== null && isExistingMirrorWorkflowError(error, mirrorName)) {
        continue;
      }
      throw error;
    }
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
