import { sql } from "drizzle-orm";
import { z } from "zod";
import { EXPECTED_PEERDB_REPLICATION_SLOT_NAMES } from "../db/clickhouse-cdc-health.ts";
import { executeWithSchema, type SchemaExecutionDatabase } from "../db/typed-sql.ts";
import type { ClickHouseAccountErasureIdentifiers } from "./clickhouse-erasure.ts";
import { classifyClickHouseManagedTableEngine } from "./clickhouse-physical-erasure.ts";

const postgresWalLsnSchema = z.string().regex(/^[0-9A-F]+\/[0-9A-F]+$/i);
const walBoundaryRowSchema = z.object({
  wal_lsn: postgresWalLsnSchema,
});
const replicationSlotRowSchema = z.object({
  active: z.boolean(),
  confirmed_flush_lsn: postgresWalLsnSchema.nullable(),
  reached_target: z.boolean(),
  slot_name: z.enum(EXPECTED_PEERDB_REPLICATION_SLOT_NAMES),
  wal_status: z.string().nullable(),
});
const peerDbTableSchema = z.object({
  database: z.literal("postgres_fitness"),
  engine: z.string().min(1),
  has_activity_id: z.coerce.boolean().default(false),
  has_id: z.coerce.boolean().default(false),
  has_operation_id: z.coerce.boolean().default(false),
  has_session_id: z.coerce.boolean().default(false),
  has_sleep_session_id: z.coerce.boolean().default(false),
  has_user_id: z.coerce.boolean().default(false),
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
});
const countRowsSchema = z.tuple([z.object({ count: z.coerce.number().int().nonnegative() })]);

interface PeerDbVerificationClickHouseClient {
  query(options: {
    clickhouse_settings?: Record<string, string | number | boolean>;
    format: "JSONEachRow";
    query: string;
    query_params?: Record<string, unknown>;
  }): Promise<{ json(): Promise<unknown> }>;
}

interface PersonalDataPredicate {
  queryParameters: Record<string, unknown>;
  sql: string;
}

function personalDataPredicate(
  table: z.infer<typeof peerDbTableSchema>,
  identifiers: ClickHouseAccountErasureIdentifiers,
): PersonalDataPredicate | null {
  const predicates: string[] = [];
  const queryParameters: Record<string, unknown> = {};
  if (table.name === "user_profile" && table.has_id) {
    predicates.push("id = {user_id:UUID}");
    queryParameters.user_id = identifiers.userId;
  }
  if (table.has_user_id) {
    predicates.push("user_id = {user_id:UUID}");
    queryParameters.user_id = identifiers.userId;
  }
  if (table.has_operation_id && identifiers.operationIds.length > 0) {
    predicates.push("operation_id IN {operation_ids:Array(UUID)}");
    queryParameters.operation_ids = identifiers.operationIds;
  }
  if (table.has_activity_id && identifiers.activityIds.length > 0) {
    predicates.push("activity_id IN {activity_ids:Array(UUID)}");
    queryParameters.activity_ids = identifiers.activityIds;
  }
  if (identifiers.sleepSessionIds.length > 0) {
    if (table.has_session_id) {
      predicates.push("session_id IN {sleep_session_ids:Array(UUID)}");
      queryParameters.sleep_session_ids = identifiers.sleepSessionIds;
    }
    if (table.has_sleep_session_id) {
      predicates.push("sleep_session_id IN {sleep_session_ids:Array(UUID)}");
      queryParameters.sleep_session_ids = identifiers.sleepSessionIds;
    }
  }
  if (predicates.length === 0) return null;
  return {
    queryParameters,
    sql: predicates.map((predicate) => `(${predicate})`).join(" OR "),
  };
}

async function assertReplicationSlotsReachedBoundary(
  database: SchemaExecutionDatabase,
  walLsn: string,
): Promise<void> {
  const targetWalLsn = postgresWalLsnSchema.parse(walLsn);
  const slotNames = sql.join(
    EXPECTED_PEERDB_REPLICATION_SLOT_NAMES.map((slotName) => sql`${slotName}`),
    sql`, `,
  );
  const rows = await executeWithSchema(
    database,
    replicationSlotRowSchema,
    sql`SELECT
          slot_name,
          active,
          wal_status,
          confirmed_flush_lsn::text AS confirmed_flush_lsn,
          confirmed_flush_lsn >= ${targetWalLsn}::pg_lsn AS reached_target
        FROM pg_replication_slots
        WHERE slot_name IN (${slotNames})
        ORDER BY slot_name`,
  );
  const rowsBySlot = new Map(rows.map((row) => [row.slot_name, row]));
  for (const slotName of EXPECTED_PEERDB_REPLICATION_SLOT_NAMES) {
    const row = rowsBySlot.get(slotName);
    if (!row) {
      throw new Error(`PeerDB account-erasure proof is missing managed mirror slot ${slotName}`);
    }
    if (!row.active || row.wal_status === "lost" || !row.confirmed_flush_lsn) {
      throw new Error(
        `PeerDB managed mirror slot ${slotName} is not healthy for account-erasure proof`,
      );
    }
    if (!row.reached_target) {
      throw new Error(
        `PeerDB managed mirror slot ${slotName} has not flushed the account-erasure WAL boundary`,
      );
    }
  }
}

async function listPeerDbPersonalDataTables(
  client: PeerDbVerificationClickHouseClient,
): Promise<z.infer<typeof peerDbTableSchema>[]> {
  const result = await client.query({
    query: `SELECT
        tables.database AS database,
        tables.name AS name,
        tables.engine AS engine,
        countIf(columns.name = 'user_id') > 0 AS has_user_id,
        countIf(columns.name = 'id') > 0 AS has_id,
        countIf(columns.name = 'operation_id') > 0 AS has_operation_id,
        countIf(columns.name = 'activity_id') > 0 AS has_activity_id,
        countIf(columns.name = 'session_id') > 0 AS has_session_id,
        countIf(columns.name = 'sleep_session_id') > 0 AS has_sleep_session_id
      FROM system.tables AS tables
      INNER JOIN system.columns AS columns
        ON columns.database = tables.database
        AND columns.table = tables.name
      WHERE tables.database = 'postgres_fitness'
        AND EXISTS (
          SELECT 1
          FROM system.columns AS metadata_columns
          WHERE metadata_columns.database = tables.database
            AND metadata_columns.table = tables.name
            AND metadata_columns.name = '_peerdb_is_deleted'
        )
      GROUP BY tables.database, tables.name, tables.engine
      HAVING has_user_id
        OR has_operation_id
        OR has_activity_id
        OR has_session_id
        OR has_sleep_session_id
        OR (tables.name = 'user_profile' AND has_id)
      ORDER BY tables.name`,
    format: "JSONEachRow",
    clickhouse_settings: { log_queries: 0 },
  });
  return z.array(peerDbTableSchema).parse(await result.json());
}

async function assertNoActiveMirroredRows(
  client: PeerDbVerificationClickHouseClient,
  identifiers: ClickHouseAccountErasureIdentifiers,
): Promise<void> {
  const tables = await listPeerDbPersonalDataTables(client);
  for (const table of tables) {
    const engineKind = classifyClickHouseManagedTableEngine(table.engine);
    if (engineKind === "non-storage") {
      continue;
    }
    if (engineKind === "unsupported-storage") {
      throw new Error(
        `Unsupported ClickHouse physical storage engine for ${table.database}.${table.name}: ${table.engine}`,
      );
    }
    const predicate = personalDataPredicate(table, identifiers);
    if (!predicate) continue;
    const result = await client.query({
      query: `SELECT count() AS count
        FROM \`postgres_fitness\`.\`${table.name}\` FINAL
        WHERE _peerdb_is_deleted = 0
          AND (${predicate.sql})`,
      query_params: predicate.queryParameters,
      clickhouse_settings: { log_queries: 0 },
      format: "JSONEachRow",
    });
    const [row] = countRowsSchema.parse(await result.json());
    if (row.count !== 0) {
      throw new Error(`PeerDB still exposes active account rows in postgres_fitness.${table.name}`);
    }
  }
}

export async function captureAccountErasurePostgresWalLsn(
  database: SchemaExecutionDatabase,
): Promise<string> {
  const [row] = await executeWithSchema(
    database,
    walBoundaryRowSchema,
    sql`SELECT pg_current_wal_lsn()::text AS wal_lsn`,
  );
  if (!row) {
    throw new Error("Postgres did not return an account-erasure WAL boundary");
  }
  return row.wal_lsn;
}

export async function assertPeerDbAccountErasureDrained(
  database: SchemaExecutionDatabase,
  clickHouseClient: PeerDbVerificationClickHouseClient,
  walLsn: string,
  identifiers: ClickHouseAccountErasureIdentifiers,
): Promise<void> {
  await assertReplicationSlotsReachedBoundary(database, walLsn);
  await assertNoActiveMirroredRows(clickHouseClient, identifiers);
}
