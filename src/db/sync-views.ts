import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client, escapeIdentifier } from "pg";
import { logger } from "../logger.ts";

/** Postgres advisory lock key — serializes concurrent view sync runs across containers */
export const VIEW_SYNC_LOCK_KEY = 728370292;

/**
 * Extract the view name from a CREATE MATERIALIZED VIEW statement.
 * Handles both "CREATE MATERIALIZED VIEW" and "CREATE MATERIALIZED VIEW IF NOT EXISTS".
 */
export function extractViewName(sqlContent: string): string | null {
  const match = sqlContent.match(/CREATE\s+MATERIALIZED\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)/i);
  return match?.[1] ?? null;
}

/**
 * Compute a SHA-256 hash of the SQL content, ignoring leading comments and whitespace
 * so that comment-only changes don't trigger expensive view recreation.
 */
export function hashViewContent(sqlContent: string): string {
  // Strip leading SQL comments and blank lines, then normalize whitespace
  const normalized = sqlContent
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--") || line.includes("statement-breakpoint"))
    .join("\n")
    .trim();
  return createHash("sha256").update(normalized).digest("hex");
}

function splitSqlStatements(sqlContent: string): string[] {
  return sqlContent
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function normalizeComparableSql(sqlContent: string): string {
  return sqlContent.replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
}

function extractViewDefinitionBody(sqlContent: string): string | null {
  const createStatement = splitSqlStatements(sqlContent)[0];
  if (!createStatement) {
    return null;
  }

  const match = createStatement.match(
    /CREATE\s+MATERIALIZED\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+AS\s+([\s\S]*)$/i,
  );
  return match?.[1]?.trim() ?? null;
}

function quoteQualifiedIdentifier(name: string): string {
  return name
    .split(".")
    .map((part) => escapeIdentifier(part))
    .join(".");
}

function parseQualifiedName(name: string): { schema: string; relation: string } {
  const dotIndex = name.indexOf(".");
  return {
    schema: dotIndex >= 0 ? name.slice(0, dotIndex) : "public",
    relation: dotIndex >= 0 ? name.slice(dotIndex + 1) : name,
  };
}

async function recordMaterializedViewHash(
  client: Pick<Client, "query">,
  viewName: string,
  hash: string,
  dependencyFingerprintHash: string,
): Promise<void> {
  await client.query(
    `INSERT INTO drizzle.__view_hashes (view_name, hash, dependency_fingerprint_hash, applied_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (view_name) DO UPDATE
     SET hash = $2,
         dependency_fingerprint_hash = $3,
         applied_at = NOW()`,
    [viewName, hash, dependencyFingerprintHash],
  );
}

export async function ensureMaterializedViewTrackingTables(
  client: Pick<Client, "query">,
): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS drizzle.__view_hashes (
    view_name TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await client.query(`ALTER TABLE drizzle.__view_hashes
    ADD COLUMN IF NOT EXISTS dependency_fingerprint_hash TEXT`);
}

export async function computeViewDependencyFingerprintHash(
  client: Pick<Client, "query">,
  viewName: string,
): Promise<string> {
  const { schema, relation } = parseQualifiedName(viewName);
  // cspell:disable -- Postgres system catalog column names
  const result = await client.query<{ fingerprint_source: string }>(
    `WITH target_view AS (
      SELECT view_class.oid
      FROM pg_class AS view_class
      JOIN pg_namespace AS view_namespace ON view_namespace.oid = view_class.relnamespace
      WHERE view_namespace.nspname = $1
        AND view_class.relname = $2
        AND view_class.relkind = 'm'
    ), dependency_rows AS (
      SELECT DISTINCT
        dependency_namespace.nspname AS schema_name,
        dependency_class.relname AS table_name,
        COALESCE(dependency_attribute.attname, '*') AS column_name,
        COALESCE(
          format_type(dependency_attribute.atttypid, dependency_attribute.atttypmod),
          ''
        ) AS data_type,
        COALESCE(dependency_attribute.attnotnull, FALSE) AS not_null
      FROM target_view
      JOIN pg_rewrite AS rewrite_rule ON rewrite_rule.ev_class = target_view.oid
      JOIN pg_depend AS dependency ON dependency.objid = rewrite_rule.oid
      JOIN pg_class AS dependency_class ON dependency_class.oid = dependency.refobjid
      JOIN pg_namespace AS dependency_namespace ON dependency_namespace.oid = dependency_class.relnamespace
      LEFT JOIN pg_attribute AS dependency_attribute
        ON dependency_attribute.attrelid = dependency_class.oid
       AND dependency_attribute.attnum = dependency.refobjsubid
       AND dependency.refobjsubid > 0
      WHERE dependency_class.relkind IN ('r', 'p', 'v', 'm')
        AND dependency_namespace.nspname NOT IN ('pg_catalog', 'information_schema')
    )
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'schema_name', schema_name,
          'table_name', table_name,
          'column_name', column_name,
          'data_type', data_type,
          'not_null', not_null
        )
        ORDER BY schema_name, table_name, column_name, data_type, not_null
      )::text,
      '[]'
    ) AS fingerprint_source
    FROM dependency_rows`,
    [schema, relation],
  );
  // cspell:enable
  return hashViewContent(result.rows[0]?.fingerprint_source ?? "[]");
}

/**
 * Check whether a materialized view exists in the PostgreSQL catalog.
 * Returns true if the view is present (regardless of whether it's populated).
 * This catches views that were CASCADE-dropped when a dependency was recreated.
 */
export async function viewExistsInCatalog(
  client: Pick<Client, "query">,
  viewName: string,
): Promise<boolean> {
  const { schema, relation } = parseQualifiedName(viewName);
  const result = await client.query(
    "SELECT 1 FROM pg_matviews WHERE schemaname = $1 AND matviewname = $2",
    [schema, relation],
  );
  return result.rows.length > 0;
}

/**
 * Check whether a materialized view has been populated (has data loaded).
 * A view created with WITH NO DATA, or one whose population was interrupted
 * by a crash, will report a false populated flag in pg_matviews.
 */
export async function isViewPopulated(
  client: Pick<Client, "query">,
  viewName: string,
): Promise<boolean> {
  const { schema, relation } = parseQualifiedName(viewName);
  const result = await client.query<{ populated: boolean }>(
    // cspell:disable-next-line -- Postgres system catalog column name
    "SELECT ispopulated AS populated FROM pg_matviews WHERE schemaname = $1 AND matviewname = $2",
    [schema, relation],
  );
  // If the view doesn't exist in pg_matviews, treat as not populated
  return result.rows[0]?.populated === true;
}

async function getMaterializedViewDefinition(
  client: Pick<Client, "query">,
  viewName: string,
): Promise<string | null> {
  const result = await client.query<{ definition: string }>(
    "SELECT pg_get_viewdef($1::regclass, true) AS definition",
    [viewName],
  );
  const definition = result.rows[0]?.definition;
  return typeof definition === "string" ? definition : null;
}

/**
 * Synchronize materialized view definitions from drizzle/_views/ SQL files.
 *
 * For each view file:
 * 1. Compute a SHA-256 hash of the SQL content
 * 2. Compare against the stored hash in drizzle.__view_hashes
 * 3. Create missing views, but do not drop or rebuild existing views automatically
 * 4. After processing all views, refresh any that exist but are unpopulated
 *    (can happen after a Postgres crash during recovery)
 *
 * Definition drift on an existing view requires explicit maintenance. This
 * avoids the downtime and lock pressure caused by destructive rebuilds during
 * deploy or sync startup.
 */
export async function syncMaterializedViews(
  databaseUrl: string,
  viewsDir?: string,
): Promise<{ synced: number; skipped: number; refreshed: number }> {
  const dir = viewsDir ?? resolve(import.meta.dirname, "../../drizzle/_views");
  const files = readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    return { synced: 0, skipped: 0, refreshed: 0 };
  }

  // Single connection — advisory locks are session-scoped, so the lock, all DDL,
  // and the unlock must run on the same connection.
  const client = new Client({ connectionString: databaseUrl });
  let lockAcquired = false;

  try {
    await client.connect();
    // Serialize view sync across containers — prevents two containers from
    // racing to DROP/CREATE the same materialized view simultaneously.
    await client.query("SELECT pg_advisory_lock($1)", [VIEW_SYNC_LOCK_KEY]);
    lockAcquired = true;

    await ensureMaterializedViewTrackingTables(client);

    let synced = 0;
    let skipped = 0;
    const allViewNames: string[] = [];
    const failedViews: Array<{ viewName: string; error: unknown }> = [];
    const maintenanceRequiredViews: Array<{ viewName: string; reason: string }> = [];

    for (const file of files) {
      const content = readFileSync(join(dir, file), "utf-8");
      const hash = hashViewContent(content);
      const viewName = extractViewName(content);

      if (!viewName) {
        logger.warn(`[views] Could not extract view name from ${file}, skipping`);
        continue;
      }

      allViewNames.push(viewName);

      // Check if this view's definition has changed
      const existing = await client.query<{
        hash: string;
        dependency_fingerprint_hash: string | null;
      }>(
        `SELECT hash, dependency_fingerprint_hash
         FROM drizzle.__view_hashes
         WHERE view_name = $1`,
        [viewName],
      );
      const stored = existing.rows[0];
      const storedHash = stored?.hash;
      const dependencyFingerprintHash = await computeViewDependencyFingerprintHash(
        client,
        viewName,
      );
      const dependencyFingerprintChanged =
        stored?.dependency_fingerprint_hash !== null &&
        stored?.dependency_fingerprint_hash !== undefined &&
        stored.dependency_fingerprint_hash !== dependencyFingerprintHash;

      if (storedHash === hash && !dependencyFingerprintChanged) {
        // Verify the view still exists — it may have been CASCADE-dropped
        // when a dependency was recreated.
        const exists = await viewExistsInCatalog(client, viewName);
        if (exists) {
          const canonicalDefinition = extractViewDefinitionBody(content);
          const liveDefinition = await getMaterializedViewDefinition(client, viewName);
          if (
            canonicalDefinition &&
            liveDefinition &&
            normalizeComparableSql(canonicalDefinition) === normalizeComparableSql(liveDefinition)
          ) {
            logger.info(`[views] ${viewName} unchanged, skipping`);
            skipped++;
            continue;
          }
          logger.warn(`[views] ${viewName} hash matches but live definition differs`);
        } else {
          logger.warn(
            `[views] ${viewName} hash matches but view is missing (CASCADE-dropped?), creating`,
          );
        }
      }
      if (storedHash === hash && dependencyFingerprintChanged) {
        logger.warn(`[views] ${viewName} dependency fingerprint changed`);
      }

      const existsBeforeCreate = await viewExistsInCatalog(client, viewName);
      if (existsBeforeCreate) {
        const canonicalDefinition = extractViewDefinitionBody(content);
        const liveDefinition = await getMaterializedViewDefinition(client, viewName);

        if (
          !storedHash &&
          canonicalDefinition &&
          liveDefinition &&
          normalizeComparableSql(canonicalDefinition) === normalizeComparableSql(liveDefinition)
        ) {
          await recordMaterializedViewHash(client, viewName, hash, dependencyFingerprintHash);
          logger.info(
            `[views] ${viewName} exists and matches canonical definition, recording hash`,
          );
          skipped++;
          continue;
        }

        const reason =
          storedHash === hash && dependencyFingerprintChanged
            ? "dependency fingerprint changed"
            : storedHash === hash
              ? "live definition differs from canonical definition"
              : "view definition changed";
        logger.error(
          `[views] ${viewName} ${reason}; manual materialized-view maintenance required`,
        );
        maintenanceRequiredViews.push({ viewName, reason });
        continue;
      }

      // View is missing or new — create it from the canonical definition without
      // dropping any existing live object. Existing changed views require manual
      // maintenance so deploy/runtime sync cannot remove serving views.
      try {
        const createStart = performance.now();
        logger.info(`[views] ${viewName} missing, creating`);

        const statements = splitSqlStatements(content);
        for (const statement of statements) {
          await client.query(statement);
        }

        // Record the fingerprint after the view exists so the dependency query
        // sees the newly created catalog dependencies.
        const createdDependencyFingerprintHash = await computeViewDependencyFingerprintHash(
          client,
          viewName,
        );
        await recordMaterializedViewHash(client, viewName, hash, createdDependencyFingerprintHash);
        logger.info(
          `[views] ${viewName} create finished duration_ms=${Math.round(performance.now() - createStart)}`,
        );
        synced++;
      } catch (error) {
        logger.error(`[views] Failed to create ${viewName}: ${error}`);
        failedViews.push({ viewName, error });
      }
    }

    // Refresh any views that exist but are unpopulated (e.g., after a Postgres crash
    // that interrupted view population, leaving them marked as not populated in pg_matviews).
    let refreshed = 0;
    for (const viewName of allViewNames) {
      const populated = await isViewPopulated(client, viewName);
      if (!populated) {
        const exists = await viewExistsInCatalog(client, viewName);
        if (!exists) {
          // View doesn't exist (failed creation earlier) — skip refresh
          continue;
        }
        const refreshStart = performance.now();
        logger.warn(`[views] ${viewName} exists but is not populated, refreshing`);
        await client.query(`REFRESH MATERIALIZED VIEW ${quoteQualifiedIdentifier(viewName)}`);
        logger.info(
          `[views] ${viewName} unpopulated refresh finished duration_ms=${Math.round(performance.now() - refreshStart)}`,
        );
        refreshed++;
      }
    }

    if (failedViews.length > 0) {
      const names = failedViews.map(({ viewName }) => viewName).join(", ");
      throw new AggregateError(
        failedViews.map(({ error }) => error),
        `Failed to create ${failedViews.length} view(s): ${names}`,
      );
    }

    if (maintenanceRequiredViews.length > 0) {
      const details = maintenanceRequiredViews
        .map(({ viewName, reason }) => `${viewName} (${reason})`)
        .join(", ");
      throw new Error(`Materialized view maintenance required: ${details}`);
    }

    await client.query(`UPDATE drizzle.__drizzle_migrations
      SET materialized_view_refresh_acknowledged_at = NOW()
      WHERE requires_materialized_view_refresh = TRUE
        AND materialized_view_refresh_acknowledged_at IS NULL`);

    return { synced, skipped, refreshed };
  } finally {
    if (lockAcquired) {
      await client
        .query("SELECT pg_advisory_unlock($1)", [VIEW_SYNC_LOCK_KEY])
        .catch((error: unknown) => {
          logger.warn("View sync advisory unlock failed: %s", error);
        });
    }
    await client.end().catch((error: unknown) => {
      logger.warn("View sync client shutdown failed: %s", error);
    });
  }
}
