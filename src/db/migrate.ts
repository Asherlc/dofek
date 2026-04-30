import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { logger } from "../logger.ts";

/** Postgres advisory lock key — serializes concurrent migration runs across containers */
export const MIGRATION_LOCK_KEY = 728370291;
const METRIC_STREAM_ID_BACKFILL_MARKER = "-- dofek:backfill-metric-stream-id";
const METRIC_STREAM_ID_BACKFILL_WINDOW_MILLISECONDS = 60 * 60 * 1000;

interface MetricStreamChunkRow {
  chunk_schema: string;
  chunk_name: string;
  range_start: Date | string | null;
  range_end: Date | string | null;
}

interface MetricStreamNullIdBoundsRow {
  range_start: Date | string | null;
  range_end: Date | string | null;
}

/**
 * Detect migration files that share the same numeric prefix (e.g., two 0049_* files).
 * This indicates concurrent PRs created conflicting migrations that must be reconciled.
 */
export function detectDuplicatePrefixes(files: Array<string>): Array<[string, Array<string>]> {
  const byPrefix = new Map<string, Array<string>>();
  for (const file of files) {
    const match = file.match(/^(\d+)_/);
    if (!match) continue;
    const prefix = match[1] ?? "";
    const group = byPrefix.get(prefix);
    if (group) {
      group.push(file);
    } else {
      byPrefix.set(prefix, [file]);
    }
  }
  return [...byPrefix.entries()].filter(([, group]) => group.length > 1);
}

/** Compute a SHA-256 hex digest of migration file content. */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isBaselineMigration(file: string): boolean {
  return /^\d+_baseline(?:_.*)?\.sql$/.test(file);
}

function migrationRequiresMaterializedViewRefresh(content: string): boolean {
  return content.includes("-- requires_materialized_view_refresh");
}

/** Parse SQL file into individual statements, split on `--> statement-breakpoint`. */
function parseStatements(content: string): Array<string> {
  return content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function backfillMetricStreamIdsForChunkRange(
  client: Client,
  rangeStart: Date | string,
  rangeEnd: Date | string,
): Promise<number> {
  const chunkRangeStart = parseMigrationDate(rangeStart);
  const chunkRangeEnd = parseMigrationDate(rangeEnd);
  if (chunkRangeEnd <= chunkRangeStart) {
    throw new Error("metric_stream ID backfill chunk range did not advance");
  }

  const result = await client.query(
    `UPDATE fitness.metric_stream AS metric_stream
      SET id = gen_random_uuid()
      WHERE metric_stream.id IS NULL
        AND metric_stream.recorded_at >= $1
        AND metric_stream.recorded_at < $2`,
    [chunkRangeStart, chunkRangeEnd],
  );
  return result.rowCount ?? 0;
}

async function backfillMetricStreamIdsForHourlyWindows(
  client: Client,
  rangeStart: Date | string,
  rangeEnd: Date | string,
): Promise<number> {
  let totalRows = 0;
  let windowStart = parseMigrationDate(rangeStart);
  const finalRangeEnd = parseMigrationDate(rangeEnd);

  while (windowStart < finalRangeEnd) {
    const nextWindowEnd = new Date(
      Math.min(
        windowStart.getTime() + METRIC_STREAM_ID_BACKFILL_WINDOW_MILLISECONDS,
        finalRangeEnd.getTime(),
      ),
    );
    if (nextWindowEnd <= windowStart) {
      throw new Error("metric_stream ID backfill time window did not advance");
    }

    const result = await client.query(
      `UPDATE fitness.metric_stream AS metric_stream
      SET id = gen_random_uuid()
      WHERE metric_stream.id IS NULL
        AND metric_stream.recorded_at >= $1
        AND metric_stream.recorded_at < $2`,
      [windowStart, nextWindowEnd],
    );
    totalRows += result.rowCount ?? 0;
    windowStart = nextWindowEnd;
  }

  return totalRows;
}

function isTimescaleTupleDecompressionLimitError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("tuple decompression limit exceeded");
}

async function backfillMetricStreamIdsWithoutChunkRanges(client: Client): Promise<number> {
  const boundsResult = await client.query<MetricStreamNullIdBoundsRow>(`
    SELECT
      min(recorded_at) AS range_start,
      max(recorded_at) + INTERVAL '1 millisecond' AS range_end
    FROM fitness.metric_stream
    WHERE id IS NULL
  `);

  const bounds = boundsResult.rows[0];
  if (!bounds?.range_start || !bounds.range_end) {
    return 0;
  }

  return backfillMetricStreamIdsForChunkRange(client, bounds.range_start, bounds.range_end);
}

function parseMigrationDate(value: Date | string): Date {
  if (value instanceof Date) {
    return value;
  }

  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) {
    throw new Error(`Invalid migration timestamp: ${value}`);
  }
  return parsedDate;
}

async function backfillMetricStreamIds(client: Client): Promise<void> {
  logger.info("[migrate] Backfilling metric_stream.id in Timescale chunk ranges");

  const chunksResult = await client.query<MetricStreamChunkRow>(`
    SELECT chunk_schema, chunk_name, range_start, range_end
    FROM timescaledb_information.chunks
    WHERE hypertable_schema = 'fitness'
      AND hypertable_name = 'metric_stream'
    ORDER BY range_start NULLS FIRST, chunk_schema, chunk_name
  `);

  if (chunksResult.rows.length === 0) {
    const totalRows = await backfillMetricStreamIdsWithoutChunkRanges(client);
    logger.info(`[migrate] Backfilled ${totalRows} metric_stream.id row(s) without chunk ranges`);
    return;
  }

  let totalRows = 0;
  for (const chunk of chunksResult.rows) {
    if (!chunk.range_start || !chunk.range_end) {
      logger.warn(
        `[migrate] Skipping metric_stream chunk with missing time bounds: ${chunk.chunk_schema}.${chunk.chunk_name}`,
      );
      continue;
    }

    let chunkRows: number;
    try {
      chunkRows = await backfillMetricStreamIdsForChunkRange(
        client,
        chunk.range_start,
        chunk.range_end,
      );
    } catch (error: unknown) {
      if (!isTimescaleTupleDecompressionLimitError(error)) {
        throw error;
      }
      logger.warn(
        `[migrate] Falling back to one-hour metric_stream ID backfill for ${chunk.chunk_schema}.${chunk.chunk_name}`,
      );
      chunkRows = await backfillMetricStreamIdsForHourlyWindows(
        client,
        chunk.range_start,
        chunk.range_end,
      );
    }
    totalRows += chunkRows;
    logger.info(
      `[migrate] Backfilled ${chunkRows} metric_stream.id row(s) in ${chunk.chunk_schema}.${chunk.chunk_name}`,
    );
  }

  logger.info(`[migrate] Backfilled ${totalRows} metric_stream.id row(s) across Timescale chunks`);
}

/**
 * Run pending migrations from the drizzle/ directory.
 *
 * Safe to call on every startup — skips already-applied migrations.
 * Uses a Postgres advisory lock to prevent races when multiple containers start simultaneously.
 *
 * Materialized view synchronization is handled separately by `syncMaterializedViews()`
 * in `sync-views.ts`, which only recreates views whose definitions have changed.
 * This avoids the multi-minute downtime window that unconditional view recreation causes
 * when the API server is already serving traffic during background migrations.
 */
export async function runMigrations(databaseUrl: string, migrationsDir?: string): Promise<number> {
  const dir = migrationsDir ?? resolve(import.meta.dirname, "../../drizzle");
  const client = new Client({ connectionString: databaseUrl });
  let lockAcquired = false;

  try {
    await client.connect();
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    lockAcquired = true;

    await client.query("CREATE SCHEMA IF NOT EXISTS health");
    await client.query("CREATE SCHEMA IF NOT EXISTS drizzle");

    await client.query(`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at BIGINT
    )`);

    // Add content_hash column for tamper detection (idempotent for existing DBs)
    await client.query(`ALTER TABLE drizzle.__drizzle_migrations
      ADD COLUMN IF NOT EXISTS content_hash TEXT`);
    await client.query(`ALTER TABLE drizzle.__drizzle_migrations
      ADD COLUMN IF NOT EXISTS requires_materialized_view_refresh BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE drizzle.__drizzle_migrations
      ADD COLUMN IF NOT EXISTS materialized_view_refresh_acknowledged_at TIMESTAMPTZ`);

    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const appliedResult = await client.query<{ hash: string; content_hash: string | null }>(
      "SELECT hash, content_hash FROM drizzle.__drizzle_migrations",
    );
    const applied = appliedResult.rows;
    const appliedSet = new Set(applied.map((row) => row.hash));

    // Detect in-place edits to already-applied migration files
    for (const row of applied) {
      if (!row.content_hash) continue;
      const filePath = join(dir, row.hash);
      if (!existsSync(filePath)) continue;
      const currentContent = readFileSync(filePath, "utf-8");
      const currentHash = computeContentHash(currentContent);
      if (currentHash !== row.content_hash) {
        logger.warn(
          `[migrate] ${row.hash} has been modified since it was applied. ` +
            "Editing applied migrations has no effect — write a new migration instead.",
        );
      }
    }

    let pendingFiles = files.filter((f) => !appliedSet.has(f));

    // Baseline migrations are for fresh databases only. Skip them if any
    // migration has already been applied OR if the target schema already has
    // tables (handles the case where migration tracking was reset but the
    // DB still has data — e.g., after a migration squash rollout).
    const schemaHasTables =
      (
        await client.query<{ has_tables: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'fitness' AND table_type = 'BASE TABLE'
      ) AS has_tables`)
      ).rows[0]?.has_tables === true;

    if (appliedSet.size > 0 || schemaHasTables) {
      const pendingBaselines = pendingFiles.filter(isBaselineMigration);
      for (const file of pendingBaselines) {
        const content = readFileSync(join(dir, file), "utf-8");
        const contentHash = computeContentHash(content);
        const requiresRefresh = migrationRequiresMaterializedViewRefresh(content);
        logger.info(
          `[migrate] Marking baseline migration as applied on existing database: ${file}`,
        );
        await client.query(
          `INSERT INTO drizzle.__drizzle_migrations (
            hash, created_at, content_hash, requires_materialized_view_refresh
          ) VALUES ($1, $2, $3, $4)`,
          [file, Date.now(), contentHash, requiresRefresh],
        );
        appliedSet.add(file);
      }
      pendingFiles = files.filter((f) => !appliedSet.has(f));
    }

    // Detect duplicate prefixes among pending migrations — two migrations
    // sharing a number means concurrent PRs created conflicting migrations.
    // Log a warning rather than throwing, since historical duplicates exist
    // (0018, 0022, 0023, 0024, 0041) and would block fresh-DB migrations.
    const duplicates = detectDuplicatePrefixes(pendingFiles);
    if (duplicates.length > 0) {
      const details = duplicates
        .map(([prefix, group]) => `  ${prefix}: ${group.join(", ")}`)
        .join("\n");
      logger.warn(
        `[migrate] Duplicate migration prefixes detected — consider reconciling:\n${details}`,
      );
    }

    let count = 0;
    for (const file of pendingFiles) {
      logger.info(`[migrate] Applying: ${file}`);
      const content = readFileSync(join(dir, file), "utf-8");
      const contentHash = computeContentHash(content);
      const requiresRefresh = migrationRequiresMaterializedViewRefresh(content);
      for (const stmt of parseStatements(content)) {
        if (stmt === METRIC_STREAM_ID_BACKFILL_MARKER) {
          await backfillMetricStreamIds(client);
        } else {
          await client.query(stmt);
        }
      }
      await client.query(
        `INSERT INTO drizzle.__drizzle_migrations (
          hash, created_at, content_hash, requires_materialized_view_refresh
        ) VALUES ($1, $2, $3, $4)`,
        [file, Date.now(), contentHash, requiresRefresh],
      );
      count++;
    }

    if (count > 0) {
      logger.info(`[migrate] Applied ${count} migration(s)`);
    }

    return count;
  } finally {
    if (lockAcquired) {
      await client
        .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
        .catch((error: unknown) => {
          logger.warn("Advisory unlock failed: %s", error);
        });
    }
    await client.end().catch((error: unknown) => {
      logger.warn("Migration client shutdown failed: %s", error);
    });
  }
}
