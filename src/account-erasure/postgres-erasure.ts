import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/index.ts";
import { executeWithSchema, type SchemaExecutionDatabase } from "../db/typed-sql.ts";

const SHARED_SYSTEM_TABLES = new Set([
  "fitness.body_region",
  "fitness.daily_metric_type",
  "fitness.device_priority",
  "fitness.exercise",
  "fitness.exercise_alias",
  "fitness.external_client",
  "fitness.journal_question",
  "fitness.mcp_oauth_client",
  "fitness.metric_stream_rebuild_task",
  "fitness.nutrient",
  "fitness.provider",
  "fitness.provider_connection_backfill_progress",
  "fitness.provider_priority",
  "fitness.provider_priority_audit",
  "fitness.sensor_device_priority",
  "fitness.sensor_provider_priority",
  "fitness.stripe_webhook_event",
]);

const PRESERVED_ERASURE_TABLES = new Set([
  "fitness.account_erasure_checkpoint",
  "fitness.account_erasure_identity_fence",
  "fitness.account_erasure_outbox",
  "fitness.account_erasure_preparation",
  "fitness.account_erasure_request",
]);

const USER_PROFILE_TABLE = "fitness.user_profile";

const LEGACY_USER_AGGREGATE_VIEWS = [
  { schemaName: "fitness", tableName: "cagg_metric_daily" },
  { schemaName: "fitness", tableName: "cagg_metric_weekly" },
  { schemaName: "fitness", tableName: "cagg_sensor_daily" },
  { schemaName: "fitness", tableName: "cagg_sensor_weekly" },
] as const;

// Processing history rejects direct child mutations. Deleting the owned
// operation uses the declared ON DELETE CASCADE path that the trigger permits.
const PROCESSING_OPERATION_CASCADE_CHILD_TABLES = new Set([
  "fitness.processing_flow_marker",
  "fitness.processing_metric_stream_batch",
  "fitness.processing_operation_output",
  "fitness.processing_queue_outbox",
  "fitness.processing_stage_event",
]);

const managedTableRowSchema = z.object({
  has_direct_owner: z.boolean(),
  has_direct_trigger: z.boolean(),
  has_transitive_trigger: z.boolean(),
  is_owned: z.boolean(),
  owner_column_type: z.string().nullable(),
  relation_oid: z.coerce.number().int().positive(),
  schema_name: z.string().min(1),
  table_name: z.string().min(1),
});

const foreignKeyRowSchema = z.object({
  child_schema: z.string().min(1),
  child_table: z.string().min(1),
  constraint_name: z.string().min(1),
  parent_schema: z.string().min(1),
  parent_table: z.string().min(1),
});

const countRowSchema = z.object({
  count: z.coerce.number().int().nonnegative(),
});
const requestRowSchema = z.object({ id: z.uuid() });

interface ManagedTable {
  directOwner: boolean;
  directTrigger: boolean;
  key: string;
  oid: number;
  owned: boolean;
  ownerColumnType: string | null;
  schemaName: string;
  tableName: string;
  transitiveTrigger: boolean;
}

interface ForeignKeyRelationship {
  childKey: string;
  constraintName: string;
  parentKey: string;
}

function tableKey(schemaName: string, tableName: string): string {
  return `${schemaName}.${tableName}`;
}

async function inspectManagedTables(database: SchemaExecutionDatabase): Promise<ManagedTable[]> {
  const rows = await executeWithSchema(
    database,
    managedTableRowSchema,
    sql`WITH RECURSIVE managed_table AS (
          SELECT
            relation.oid,
            namespace.nspname AS schema_name,
            relation.relname AS table_name,
            (
              namespace.nspname = 'fitness'
              AND relation.relname = 'user_profile'
            ) OR (
              NOT fitness.account_erasure_relation_is_ownership_neutral(
                relation.oid
              )
              AND EXISTS (
                SELECT 1
                FROM pg_attribute AS owner_column
                WHERE owner_column.attrelid = relation.oid
                  AND owner_column.attname = 'user_id'
                  AND owner_column.attnum > 0
                  AND NOT owner_column.attisdropped
              )
            ) AS has_direct_owner
          FROM pg_class AS relation
          JOIN pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname IN ('fitness', 'analytics')
            AND relation.relkind IN ('r', 'p')
        ),
        direct_owned AS (
          SELECT oid
          FROM managed_table
          WHERE has_direct_owner
        ),
        owned AS (
          SELECT oid
          FROM direct_owned
          UNION
          SELECT child.oid
          FROM owned AS parent_owner
          JOIN pg_constraint AS foreign_key
            ON foreign_key.confrelid = parent_owner.oid
            AND foreign_key.contype = 'f'
          JOIN managed_table AS child
            ON child.oid = foreign_key.conrelid
          WHERE NOT fitness.account_erasure_relation_is_ownership_neutral(
            child.oid
          )
        )
        SELECT
          managed_table.oid AS relation_oid,
          managed_table.schema_name,
          managed_table.table_name,
          managed_table.has_direct_owner,
          managed_table.oid IN (SELECT oid FROM owned) AS is_owned,
          (
            SELECT format_type(
              owner_column.atttypid,
              owner_column.atttypmod
            )
            FROM pg_attribute AS owner_column
            WHERE owner_column.attrelid = managed_table.oid
              AND owner_column.attname = CASE
                WHEN managed_table.schema_name = 'fitness'
                  AND managed_table.table_name = 'user_profile'
                THEN 'id'
                ELSE 'user_id'
              END
              AND owner_column.attnum > 0
              AND NOT owner_column.attisdropped
          ) AS owner_column_type,
          EXISTS (
            SELECT 1
            FROM pg_trigger AS trigger
            JOIN pg_proc AS trigger_function
              ON trigger_function.oid = trigger.tgfoid
            WHERE trigger.tgrelid = managed_table.oid
              AND NOT trigger.tgisinternal
              AND trigger_function.proname =
                'reject_account_erasure_write'
          ) AS has_direct_trigger,
          EXISTS (
            SELECT 1
            FROM pg_trigger AS trigger
            JOIN pg_proc AS trigger_function
              ON trigger_function.oid = trigger.tgfoid
            WHERE trigger.tgrelid = managed_table.oid
              AND NOT trigger.tgisinternal
              AND trigger_function.proname =
                'reject_transitive_account_erasure_write'
          ) AS has_transitive_trigger
        FROM managed_table
        ORDER BY
          managed_table.schema_name,
          managed_table.table_name`,
  );
  return rows.map((row) => ({
    directOwner: row.has_direct_owner,
    directTrigger: row.has_direct_trigger,
    key: tableKey(row.schema_name, row.table_name),
    oid: row.relation_oid,
    owned: row.is_owned,
    ownerColumnType: row.owner_column_type,
    schemaName: row.schema_name,
    tableName: row.table_name,
    transitiveTrigger: row.has_transitive_trigger,
  }));
}

async function inspectForeignKeys(
  database: SchemaExecutionDatabase,
): Promise<ForeignKeyRelationship[]> {
  const rows = await executeWithSchema(
    database,
    foreignKeyRowSchema,
    sql`SELECT
          foreign_key.conname AS constraint_name,
          child_namespace.nspname AS child_schema,
          child.relname AS child_table,
          parent_namespace.nspname AS parent_schema,
          parent.relname AS parent_table
        FROM pg_constraint AS foreign_key
        JOIN pg_class AS child ON child.oid = foreign_key.conrelid
        JOIN pg_namespace AS child_namespace
          ON child_namespace.oid = child.relnamespace
        JOIN pg_class AS parent ON parent.oid = foreign_key.confrelid
        JOIN pg_namespace AS parent_namespace
          ON parent_namespace.oid = parent.relnamespace
        WHERE foreign_key.contype = 'f'
          AND child_namespace.nspname IN ('fitness', 'analytics')
          AND parent_namespace.nspname IN ('fitness', 'analytics')
        ORDER BY
          child_namespace.nspname,
          child.relname,
          foreign_key.conname`,
  );
  return rows.map((row) => ({
    childKey: tableKey(row.child_schema, row.child_table),
    constraintName: row.constraint_name,
    parentKey: tableKey(row.parent_schema, row.parent_table),
  }));
}

function coverageFailures(tables: readonly ManagedTable[]): string[] {
  const failures: string[] = [];
  for (const table of tables) {
    const isExplicitShared = SHARED_SYSTEM_TABLES.has(table.key);
    const isPreservedErasureState = PRESERVED_ERASURE_TABLES.has(table.key);
    if (
      table.owned &&
      table.key !== USER_PROFILE_TABLE &&
      (isExplicitShared || isPreservedErasureState)
    ) {
      failures.push(`${table.key} is both user-owned and preservation-allowlisted`);
      continue;
    }
    if (!table.owned && !isExplicitShared && !isPreservedErasureState) {
      failures.push(`${table.key} has no ownership or shared-system policy`);
      continue;
    }
    if (table.directOwner && table.ownerColumnType !== "uuid") {
      failures.push(
        `${table.key} has a non-UUID owner column (${table.ownerColumnType ?? "missing"})`,
      );
    }
    if (table.owned && table.directOwner && !table.directTrigger) {
      failures.push(`${table.key} is missing its direct write fence`);
    }
    if (table.owned && !table.directOwner && !table.transitiveTrigger) {
      failures.push(`${table.key} is missing its transitive write fence`);
    }
  }
  return failures;
}

export async function assertPostgresAccountErasureCoverage(
  database: SchemaExecutionDatabase,
): Promise<void> {
  const failures = coverageFailures(await inspectManagedTables(database));
  if (failures.length > 0) {
    throw new Error(`Postgres account-erasure schema coverage failed: ${failures.join("; ")}`);
  }
}

/**
 * Rebuilds catalog-derived triggers after a migration adds a managed table or
 * foreign key. Coverage remains a separate fail-closed check so new shared
 * tables still require an explicit policy decision.
 */
export async function refreshPostgresAccountErasureWriteFences(
  database: SchemaExecutionDatabase,
): Promise<void> {
  await database.execute(sql`SELECT fitness.refresh_account_erasure_write_fences()`);
}

function dependencySafeDeletionOrder(
  tables: readonly ManagedTable[],
  relationships: readonly ForeignKeyRelationship[],
): ManagedTable[] {
  const ownedByKey = new Map(
    tables.filter((table) => table.owned).map((table) => [table.key, table]),
  );
  const childrenByParent = new Map<string, Set<string>>();
  for (const relationship of relationships) {
    if (
      relationship.childKey === relationship.parentKey ||
      !ownedByKey.has(relationship.childKey) ||
      !ownedByKey.has(relationship.parentKey)
    ) {
      continue;
    }
    const children = childrenByParent.get(relationship.parentKey) ?? new Set<string>();
    children.add(relationship.childKey);
    childrenByParent.set(relationship.parentKey, children);
  }

  const ordered: ManagedTable[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visited.has(key)) return;
    if (visiting.has(key)) {
      const constraints = relationships
        .filter((relationship) => relationship.childKey === key || relationship.parentKey === key)
        .map((relationship) => relationship.constraintName)
        .sort();
      throw new Error(
        `Postgres account erasure cannot order cyclic ownership at ${key}: ${constraints.join(", ")}`,
      );
    }
    visiting.add(key);
    const children = [...(childrenByParent.get(key) ?? [])].sort();
    for (const child of children) visit(child);
    visiting.delete(key);
    visited.add(key);
    const table = ownedByKey.get(key);
    if (table) ordered.push(table);
  };

  for (const key of [...ownedByKey.keys()].sort()) visit(key);
  return ordered;
}

function qualifiedTable(table: Pick<ManagedTable, "schemaName" | "tableName">) {
  return sql`${sql.identifier(table.schemaName)}.${sql.identifier(table.tableName)}`;
}

async function deleteLegacyUserAggregateRows(
  database: SchemaExecutionDatabase,
  userId: string,
): Promise<void> {
  for (const view of LEGACY_USER_AGGREGATE_VIEWS) {
    await database.execute(
      sql`DELETE FROM ${qualifiedTable(view)} AS legacy_aggregate
          WHERE legacy_aggregate.user_id = ${userId}::uuid`,
    );
  }
}

async function assertNoLegacyUserAggregateRowsRemain(
  database: SchemaExecutionDatabase,
  userId: string,
): Promise<void> {
  for (const view of LEGACY_USER_AGGREGATE_VIEWS) {
    const counts = await executeWithSchema(
      database,
      countRowSchema,
      sql`SELECT count(*)::integer AS count
          FROM ${qualifiedTable(view)} AS legacy_aggregate
          WHERE legacy_aggregate.user_id = ${userId}::uuid`,
    );
    if (counts[0]?.count !== 0) {
      throw new Error(
        `Postgres account erasure left legacy aggregate rows in ${view.schemaName}.${view.tableName}`,
      );
    }
  }
}

async function resetProviderConnectionBackfillCursor(
  database: SchemaExecutionDatabase,
  userId: string,
): Promise<void> {
  await database.execute(
    sql`UPDATE fitness.provider_connection_backfill_progress
        SET
          last_user_id = NULL,
          last_provider_id = NULL,
          updated_at = now()
        WHERE last_user_id = ${userId}::uuid`,
  );
}

async function assertNoProviderConnectionBackfillCursorRemains(
  database: SchemaExecutionDatabase,
  userId: string,
): Promise<void> {
  const counts = await executeWithSchema(
    database,
    countRowSchema,
    sql`SELECT count(*)::integer AS count
        FROM fitness.provider_connection_backfill_progress
        WHERE last_user_id = ${userId}::uuid`,
  );
  if (counts[0]?.count !== 0) {
    throw new Error("Postgres account erasure left a provider-connection backfill cursor");
  }
}

async function prepareExerciseProvenance(
  database: SchemaExecutionDatabase,
  userId: string,
): Promise<void> {
  await database.execute(
    sql`CREATE TEMP TABLE account_erasure_exercise_candidate
        ON COMMIT DROP
        AS
        SELECT source.exercise_id
        FROM fitness.exercise_source AS source
        WHERE source.user_id = ${userId}::uuid
        UNION
        SELECT strength.exercise_id
        FROM fitness.strength_set AS strength
        JOIN fitness.activity AS activity
          ON activity.id = strength.activity_id
        WHERE activity.user_id = ${userId}::uuid`,
  );
  await database.execute(
    sql`WITH ordered_candidate AS MATERIALIZED (
          SELECT exercise_id
          FROM account_erasure_exercise_candidate
          ORDER BY exercise_id
        )
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            'account-erasure-exercise:' || exercise_id::text,
            0
          )
        )
        FROM ordered_candidate
        ORDER BY exercise_id`,
  );
  await database.execute(
    sql`INSERT INTO fitness.exercise_source (
          exercise_id,
          source_kind,
          user_id,
          provider_id
        )
        SELECT DISTINCT
          strength.exercise_id,
          'user',
          activity.user_id,
          activity.provider_id
        FROM fitness.strength_set AS strength
        JOIN fitness.activity AS activity
          ON activity.id = strength.activity_id
        JOIN account_erasure_exercise_candidate AS candidate
          ON candidate.exercise_id = strength.exercise_id
        WHERE activity.user_id <> ${userId}::uuid
          AND NOT EXISTS (
            SELECT 1
            FROM fitness.account_erasure_request AS active_erasure
            WHERE active_erasure.user_id = activity.user_id
              AND active_erasure.status <> 'completed'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM fitness.exercise_source AS existing_source
            WHERE existing_source.exercise_id = strength.exercise_id
              AND existing_source.source_kind = 'user'
              AND existing_source.user_id = activity.user_id
              AND existing_source.provider_id = activity.provider_id
          )
        ON CONFLICT (
          exercise_id,
          user_id,
          provider_id
        ) WHERE source_kind = 'user'
        DO NOTHING`,
  );
  await database.execute(
    sql`INSERT INTO fitness.exercise_alias_source (
          alias_id,
          source_id,
          exercise_id
        )
        SELECT
          alias.id,
          source.id,
          source.exercise_id
        FROM fitness.exercise_alias AS alias
        JOIN fitness.exercise_source AS source
          ON source.exercise_id = alias.exercise_id
          AND source.provider_id = alias.provider_id
        JOIN account_erasure_exercise_candidate AS candidate
          ON candidate.exercise_id = alias.exercise_id
        WHERE NOT EXISTS (
            SELECT 1
            FROM fitness.exercise_alias_source AS existing_alias_source
            WHERE existing_alias_source.alias_id = alias.id
              AND existing_alias_source.source_id = source.id
          )
          AND (
            source.user_id = ${userId}::uuid
            OR NOT EXISTS (
              SELECT 1
              FROM fitness.account_erasure_request AS active_erasure
              WHERE active_erasure.user_id = source.user_id
                AND active_erasure.status <> 'completed'
            )
          )
        ON CONFLICT (alias_id, source_id) DO NOTHING`,
  );
  await database.execute(
    sql`CREATE TEMP TABLE account_erasure_exercise_alias_candidate
        ON COMMIT DROP
        AS
        SELECT DISTINCT alias_source.alias_id
        FROM fitness.exercise_alias_source AS alias_source
        JOIN fitness.exercise_source AS source
          ON source.id = alias_source.source_id
        WHERE source.user_id = ${userId}::uuid
        UNION
        SELECT DISTINCT alias.id
        FROM fitness.exercise_alias AS alias
        JOIN fitness.strength_set AS strength
          ON strength.exercise_id = alias.exercise_id
        JOIN fitness.activity AS activity
          ON activity.id = strength.activity_id
          AND activity.provider_id = alias.provider_id
        WHERE activity.user_id = ${userId}::uuid`,
  );
}

async function cleanupExerciseCatalog(database: SchemaExecutionDatabase): Promise<void> {
  await database.execute(
    sql`DELETE FROM fitness.exercise_alias AS alias
        WHERE alias.id IN (
          SELECT alias_id
          FROM account_erasure_exercise_alias_candidate
        )
          AND NOT EXISTS (
            SELECT 1
            FROM fitness.exercise_alias_source AS source
            WHERE source.alias_id = alias.id
          )`,
  );
  await database.execute(
    sql`DELETE FROM fitness.exercise AS exercise
        WHERE exercise.id IN (
          SELECT exercise_id
          FROM account_erasure_exercise_candidate
        )
          AND NOT EXISTS (
            SELECT 1
            FROM fitness.exercise_source AS source
            WHERE source.exercise_id = exercise.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM fitness.strength_set AS strength
            WHERE strength.exercise_id = exercise.id
          )`,
  );
}

async function deleteOwnedRows(
  database: SchemaExecutionDatabase,
  tables: readonly ManagedTable[],
  userId: string,
): Promise<void> {
  for (const table of tables) {
    if (
      table.key === USER_PROFILE_TABLE ||
      PROCESSING_OPERATION_CASCADE_CHILD_TABLES.has(table.key)
    ) {
      continue;
    }
    await database.execute(
      sql`DELETE FROM ${qualifiedTable(table)} AS account_erasure_target
          WHERE EXISTS (
            SELECT 1
            FROM fitness.resolve_account_erasure_owner_ids(
              ${table.key}::regclass,
              to_jsonb(account_erasure_target)
            ) AS owner_id
            WHERE owner_id = ${userId}::uuid
          )`,
    );
  }
}

async function assertNoOwnedRowsRemain(
  database: SchemaExecutionDatabase,
  tables: readonly ManagedTable[],
  userId: string,
): Promise<void> {
  for (const table of tables) {
    if (!table.owned || table.key === USER_PROFILE_TABLE) continue;
    const counts = await executeWithSchema(
      database,
      countRowSchema,
      sql`SELECT count(*)::integer AS count
          FROM ${qualifiedTable(table)} AS account_erasure_target
          WHERE EXISTS (
            SELECT 1
            FROM fitness.resolve_account_erasure_owner_ids(
              ${table.key}::regclass,
              to_jsonb(account_erasure_target)
            ) AS owner_id
            WHERE owner_id = ${userId}::uuid
          )`,
    );
    if (counts[0]?.count !== 0) {
      throw new Error(`Postgres account erasure left attributable rows in ${table.key}`);
    }
  }
}

export async function assertPostgresAccountErasureComplete(
  database: SchemaExecutionDatabase,
  userId: string,
): Promise<void> {
  await assertPostgresAccountErasureCoverage(database);
  const tables = await inspectManagedTables(database);
  await assertNoOwnedRowsRemain(database, tables, userId);
  await assertNoLegacyUserAggregateRowsRemain(database, userId);
  await assertNoProviderConnectionBackfillCursorRemains(database, userId);
  const profiles = await executeWithSchema(
    database,
    countRowSchema,
    sql`SELECT count(*)::integer AS count
        FROM fitness.user_profile
        WHERE id = ${userId}::uuid`,
  );
  if (profiles[0]?.count !== 0) {
    throw new Error("Postgres account erasure left the user profile");
  }
}

export async function erasePostgresAccount(
  database: Pick<Database, "transaction">,
  requestId: string,
  userId: string,
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}::text, 0))`,
    );
    const requests = await executeWithSchema(
      transaction,
      requestRowSchema,
      sql`SELECT id
          FROM fitness.account_erasure_request
          WHERE id = ${requestId}::uuid
            AND user_id = ${userId}::uuid
            AND status <> 'completed'
          FOR UPDATE`,
    );
    if (requests.length !== 1) {
      throw new Error("Active account erasure request does not own the supplied user");
    }
    await transaction.execute(
      sql`SELECT set_config(
            'dofek.account_erasure_request_id',
            ${requestId},
            true
          )`,
    );

    await assertPostgresAccountErasureCoverage(transaction);
    const preparationCounts = await executeWithSchema(
      transaction,
      countRowSchema,
      sql`SELECT count(*)::integer AS count
          FROM fitness.account_erasure_preparation
          WHERE user_id = ${userId}::uuid`,
    );
    if (preparationCounts[0]?.count !== 0) {
      throw new Error("Postgres account erasure found an unconsumed account-erasure preparation");
    }

    await prepareExerciseProvenance(transaction, userId);
    const tables = await inspectManagedTables(transaction);
    const relationships = await inspectForeignKeys(transaction);
    const deletionOrder = dependencySafeDeletionOrder(tables, relationships);
    await deleteOwnedRows(transaction, deletionOrder, userId);
    await deleteLegacyUserAggregateRows(transaction, userId);
    await resetProviderConnectionBackfillCursor(transaction, userId);
    await cleanupExerciseCatalog(transaction);
    await transaction.execute(
      sql`UPDATE fitness.provider
          SET user_id = NULL
          WHERE user_id = ${userId}::uuid`,
    );
    await assertNoOwnedRowsRemain(transaction, tables, userId);
    await assertNoLegacyUserAggregateRowsRemain(transaction, userId);
    await assertNoProviderConnectionBackfillCursorRemains(transaction, userId);
    const legacyProviderCounts = await executeWithSchema(
      transaction,
      countRowSchema,
      sql`SELECT count(*)::integer AS count
          FROM fitness.provider
          WHERE user_id = ${userId}::uuid`,
    );
    if (legacyProviderCounts[0]?.count !== 0) {
      throw new Error("Postgres account erasure left legacy provider ownership rows");
    }
  });
}
