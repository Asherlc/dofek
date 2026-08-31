import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { z } from "zod";
import { type ClickHouseCommandClient, createClickHouseClientFromEnv } from "./clickhouse.ts";
import {
  dropObsoleteClinicalRawTables,
  transitionLegacyClinicalMirror,
  waitForCanonicalClinicalMirror,
} from "./clickhouse-clinical-cdc.ts";

interface PeerDbClient {
  query(queryText: string): Promise<unknown>;
}

interface SourcePostgresClient {
  query(queryText: string): Promise<unknown>;
}

export interface PeerDbTableMapping {
  sourceTableIdentifier: string;
  destinationTableIdentifier: string;
  exclude: readonly string[];
}

interface PeerDbMirrorStatus {
  currentFlowState: string;
  tableMappings: readonly PeerDbTableMapping[];
}

interface PeerDbCdcFlowConfigUpdate {
  additional_tables: readonly PeerDbTableMapping[];
}

interface PeerDbMirrorStateChangeRequest {
  flowJobName: string;
  requestedFlowState: "STATUS_PAUSED" | "STATUS_RUNNING";
  flowConfigUpdate?: {
    cdcFlowConfigUpdate: PeerDbCdcFlowConfigUpdate;
  };
}

export interface PeerDbMirrorListItem {
  destinationType: number | string;
  isCdc: boolean;
  name: string;
}

export interface PeerDbMirrorApiClient {
  getMirrorStatus(mirrorName: string): Promise<PeerDbMirrorStatus>;
  listMirrors(): Promise<PeerDbMirrorListItem[]>;
  changeMirrorState(request: PeerDbMirrorStateChangeRequest): Promise<void>;
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

interface SetupClickHouseCdcOptions {
  peerDbMirrorApiClient?: PeerDbMirrorApiClient;
  peerDbClient: PeerDbClient;
  sourcePostgresClient: SourcePostgresClient;
  clickHouseClient: ClickHouseCommandClient;
  templateSql: string;
  templateValues: PeerDbSqlTemplateValues;
}

interface RuntimeConfig {
  peerDbFlowApiAuthorization: string | undefined;
  peerDbFlowApiUrl: string;
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
  "clinical_record",
  "journal_entry",
  "provider",
  "provider_connection",
  "provider_priority",
  "device_priority",
  "sensor_provider_priority",
  "sensor_device_priority",
  "processing_flow_marker",
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
const peerDbMirrorStatusResponseSchema = z
  .object({
    currentFlowState: z.string().min(1),
    cdcStatus: z.object({
      config: z.object({
        tableMappings: z.array(
          z.object({
            sourceTableIdentifier: z.string().min(1),
            destinationTableIdentifier: z.string().min(1),
            exclude: z.array(z.string()).optional().default([]),
          }),
        ),
      }),
    }),
    errorMessage: z.string().optional(),
    ok: z.boolean().optional(),
  })
  .passthrough();
const peerDbMirrorListResponseSchema = z.object({
  mirrors: z.array(
    z.object({
      destinationType: z.union([z.number().int(), z.string().min(1)]),
      isCdc: z.boolean(),
      name: z.string().min(1),
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
    "provider_connection",
    "provider_priority",
    "device_priority",
    "processing_flow_marker",
    "user_profile",
  ],
  dofek_provider_inventory_raw_analytics: [
    "food_entry",
    "health_event",
    "clinical_record",
    "journal_entry",
  ],
  dofek_sensor_priority_raw_analytics: ["sensor_provider_priority", "sensor_device_priority"],
};
const requiredExistingMirrorTableMappings = {
  dofek_fitness_raw_analytics: [
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
  dofek_provider_inventory_raw_analytics: [
    {
      sourceTableIdentifier: "fitness.clinical_record",
      destinationTableIdentifier: "clinical_record",
      exclude: [],
    },
    {
      sourceTableIdentifier: "fitness.processing_flow_marker",
      destinationTableIdentifier: "processing_flow_marker_provider_inventory",
      exclude: [],
    },
  ],
} as const satisfies Partial<
  Record<(typeof rawAnalyticsMirrorNames)[number], readonly PeerDbTableMapping[]>
>;
const peerDbMirrorStatePollIntervalMs = 1_000;
const peerDbMirrorStatePollTimeoutMs = 120_000;
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

function buildPeerDbFlowApiConfig(
  sourcePostgresHost: string,
  peerDbCredential: string,
  peerDbUiPort: number,
): { authorization: string | undefined; url: string } {
  if (isLocalhost(sourcePostgresHost)) {
    return {
      authorization: `Basic ${Buffer.from(`:${peerDbCredential}`).toString("base64")}`,
      url: `http://127.0.0.1:${peerDbUiPort}/api/v1`,
    };
  }
  return { authorization: undefined, url: "http://peerdb-flow-api:8113/v1" };
}

async function parsePeerDbApiResponse(response: Response): Promise<unknown> {
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `PeerDB API request failed with HTTP ${response.status}: ${responseText || response.statusText}`,
    );
  }
  if (!responseText) {
    return {};
  }
  return JSON.parse(responseText);
}

export function createPeerDbMirrorApiClient(
  baseUrl: string,
  authorization: string | undefined,
): PeerDbMirrorApiClient {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");

  async function get(path: string): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (authorization) {
      headers.authorization = authorization;
    }
    const response = await fetch(`${normalizedBaseUrl}/${path}`, { headers });
    return parsePeerDbApiResponse(response);
  }

  async function post(path: string, body: unknown): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (authorization) {
      headers.authorization = authorization;
    }
    const response = await fetch(`${normalizedBaseUrl}/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return parsePeerDbApiResponse(response);
  }

  return {
    async getMirrorStatus(mirrorName) {
      const result = peerDbMirrorStatusResponseSchema.parse(
        await post("mirrors/status", {
          flowJobName: mirrorName,
          includeFlowInfo: true,
        }),
      );
      if (result.ok === false) {
        throw new Error(
          `PeerDB could not inspect mirror ${mirrorName}: ${result.errorMessage || "unknown error"}`,
        );
      }
      return {
        currentFlowState: result.currentFlowState,
        tableMappings: result.cdcStatus.config.tableMappings,
      };
    },
    async changeMirrorState(request) {
      const responseSchema = z
        .object({ ok: z.boolean().optional(), errorMessage: z.string().optional() })
        .passthrough();
      const result = responseSchema.parse(await post("mirrors/state_change", request));
      if (result.ok === false) {
        throw new Error(
          `PeerDB could not change mirror ${request.flowJobName}: ${result.errorMessage || "unknown error"}`,
        );
      }
    },
    async listMirrors() {
      return peerDbMirrorListResponseSchema.parse(await get("mirrors/list")).mirrors;
    },
  };
}

export function createPeerDbMirrorApiClientFromEnv(): PeerDbMirrorApiClient {
  const databaseUrl = new URL(requireEnv("DATABASE_URL"));
  if (!isLocalhost(databaseUrl.hostname)) {
    return createPeerDbMirrorApiClient("http://peerdb-flow-api:8113/v1", undefined);
  }
  const config = buildPeerDbFlowApiConfig(
    databaseUrl.hostname,
    requireEnv("POSTGRES_PASSWORD"),
    resolveTemplatePort("PEERDB_UI_PORT", 3001),
  );
  return createPeerDbMirrorApiClient(config.url, config.authorization);
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
  const peerDbFlowApi = buildPeerDbFlowApiConfig(
    databaseUrl.hostname,
    postgresCredential,
    resolveTemplatePort("PEERDB_UI_PORT", 3001),
  );

  return {
    peerDbFlowApiAuthorization: peerDbFlowApi.authorization,
    peerDbFlowApiUrl: peerDbFlowApi.url,
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

async function truncateRawAnalyticsDestinationTables(
  clickHouseClient: ClickHouseCommandClient,
  tableNames: readonly string[],
): Promise<void> {
  for (const tableName of tableNames) {
    await clickHouseClient.command({
      query: `TRUNCATE TABLE IF EXISTS postgres_fitness.${tableName}`,
    });
  }
}

async function truncateMissingInitialCopyRawAnalyticsDestinations(
  clickHouseClient: ClickHouseCommandClient,
  existingMirrorNames: Set<string>,
): Promise<void> {
  for (const mirrorName of rawAnalyticsMirrorNames) {
    if (existingMirrorNames.has(mirrorName)) {
      continue;
    }
    await truncateRawAnalyticsDestinationTables(
      clickHouseClient,
      rawAnalyticsMirrorTableMappings[mirrorName],
    );
  }
}

function mirrorHasTableMapping(
  status: PeerDbMirrorStatus,
  requiredMapping: PeerDbTableMapping,
): boolean {
  return status.tableMappings.some(
    (mapping) =>
      mapping.sourceTableIdentifier === requiredMapping.sourceTableIdentifier &&
      mapping.destinationTableIdentifier === requiredMapping.destinationTableIdentifier,
  );
}

async function waitForPeerDbMirror(
  peerDbMirrorApiClient: PeerDbMirrorApiClient,
  mirrorName: string,
  description: string,
  predicate: (status: PeerDbMirrorStatus) => boolean,
): Promise<PeerDbMirrorStatus> {
  const deadline = Date.now() + peerDbMirrorStatePollTimeoutMs;
  while (true) {
    const status = await peerDbMirrorApiClient.getMirrorStatus(mirrorName);
    if (predicate(status)) {
      return status;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for PeerDB mirror ${mirrorName} to ${description}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, peerDbMirrorStatePollIntervalMs));
  }
}

async function ensureExistingMirrorTableMappings(
  peerDbMirrorApiClient: PeerDbMirrorApiClient,
  existingMirrorNames: ReadonlySet<string>,
): Promise<void> {
  for (const [mirrorName, requiredMappings] of Object.entries(
    requiredExistingMirrorTableMappings,
  )) {
    if (!existingMirrorNames.has(mirrorName)) {
      continue;
    }

    const status = await peerDbMirrorApiClient.getMirrorStatus(mirrorName);
    const missingMappings = requiredMappings.filter(
      (requiredMapping) => !mirrorHasTableMapping(status, requiredMapping),
    );
    if (missingMappings.length === 0) {
      continue;
    }
    if (status.currentFlowState !== "STATUS_RUNNING") {
      throw new Error(
        `PeerDB mirror ${mirrorName} must be running before adding required processing marker mappings; current state is ${status.currentFlowState}`,
      );
    }

    await peerDbMirrorApiClient.changeMirrorState({
      flowJobName: mirrorName,
      requestedFlowState: "STATUS_PAUSED",
    });
    let resumedWithRequiredMappings = false;
    try {
      await waitForPeerDbMirror(
        peerDbMirrorApiClient,
        mirrorName,
        "reach STATUS_PAUSED",
        (currentStatus) => currentStatus.currentFlowState === "STATUS_PAUSED",
      );
      await peerDbMirrorApiClient.changeMirrorState({
        flowJobName: mirrorName,
        requestedFlowState: "STATUS_RUNNING",
        flowConfigUpdate: {
          cdcFlowConfigUpdate: {
            additional_tables: missingMappings,
          },
        },
      });
      await waitForPeerDbMirror(
        peerDbMirrorApiClient,
        mirrorName,
        "include required processing marker mappings and resume CDC",
        (currentStatus) =>
          currentStatus.currentFlowState === "STATUS_RUNNING" &&
          missingMappings.every((requiredMapping) =>
            mirrorHasTableMapping(currentStatus, requiredMapping),
          ),
      );
      resumedWithRequiredMappings = true;
    } finally {
      if (!resumedWithRequiredMappings) {
        await peerDbMirrorApiClient.changeMirrorState({
          flowJobName: mirrorName,
          requestedFlowState: "STATUS_RUNNING",
        });
      }
    }
  }
}

export async function setupClickHouseCdc(options: SetupClickHouseCdcOptions): Promise<void> {
  await ensureAnalyticsPeerDbColumns(options.clickHouseClient);
  await ensureAnalyticsPublication(options.sourcePostgresClient);
  await dropObsoleteMetricStreamPeerDbMirrors(options.peerDbClient);
  const renderedSql = renderPeerDbSqlTemplate(
    options.templateSql,
    options.templateValues,
  );
  const existingMirrorNames = await readExistingManagedMirrorNames(options.peerDbClient);
  const peerDbMirrorApiClient = options.peerDbMirrorApiClient;
  if (existingMirrorNames.size > 0 && !peerDbMirrorApiClient) {
    throw new Error("PeerDB mirror API client is required to reconcile existing mirror mappings");
  }
  const transitionedLegacyClinicalMirror = peerDbMirrorApiClient
    ? await transitionLegacyClinicalMirror(
        options.peerDbClient,
        peerDbMirrorApiClient,
        existingMirrorNames,
      )
    : false;
  await truncateMissingInitialCopyRawAnalyticsDestinations(
    options.clickHouseClient,
    existingMirrorNames,
  );
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
  if (transitionedLegacyClinicalMirror && peerDbMirrorApiClient) {
    await waitForCanonicalClinicalMirror(peerDbMirrorApiClient);
  }
  if (existingMirrorNames.size > 0) {
    if (!peerDbMirrorApiClient) {
      throw new Error("PeerDB mirror API client is required to reconcile existing mirror mappings");
    }
    await ensureExistingMirrorTableMappings(peerDbMirrorApiClient, existingMirrorNames);
  }
  await dropObsoleteClinicalRawTables(options.clickHouseClient);
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
      peerDbMirrorApiClient: createPeerDbMirrorApiClient(
        config.peerDbFlowApiUrl,
        config.peerDbFlowApiAuthorization,
      ),
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
