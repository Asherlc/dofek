import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import archiver from "archiver";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { SyncDatabase } from "./db/index.ts";
import { executeWithSchema } from "./lib/typed-sql.ts";
import { logger } from "./logger.ts";

const exportRowSchema = z.record(z.string(), z.unknown());
const countRowSchema = z.object({ count: z.string() });

/** Configuration for a single table to export. */
interface ExportTableConfig {
  /** Filename in the ZIP (e.g., "activities.csv") */
  name: string;
  /** SQL query that returns all rows for the given user */
  query: (db: SyncDatabase, userId: string) => Promise<Record<string, unknown>[]>;
  /** If true, query in batches (for very large tables like metric_stream) */
  batched?: boolean;
}

/** Progress callback info */
export interface ExportProgress {
  percentage: number;
  message: string;
}

/** Result of a completed export */
export interface ExportResult {
  tableCount: number;
  totalRecords: number;
}

const BATCH_SIZE = 50_000;

const EXPORT_TABLES: ExportTableConfig[] = [
  {
    name: "user-profile.csv",
    query: (db, userId) =>
      executeWithSchema(
        db,
        exportRowSchema,
        sql`SELECT * FROM fitness.user_profile WHERE id = ${userId}`,
      ),
  },
  {
    name: "activities.csv",
    query: (db, userId) =>
      executeWithSchema(
        db,
        exportRowSchema,
        sql`SELECT * FROM fitness.activity WHERE user_id = ${userId} ORDER BY started_at`,
      ),
  },
  {
    name: "activity-intervals.csv",
    query: (db, userId) =>
      executeWithSchema(
        db,
        exportRowSchema,
        sql`SELECT ai.* FROM fitness.activity_interval ai
            JOIN fitness.activity a ON a.id = ai.activity_id
            WHERE a.user_id = ${userId}
            ORDER BY ai.started_at`,
      ),
  },
  {
    name: "sleep-sessions.csv",
    query: (db, userId) =>
      executeWithSchema(
        db,
        exportRowSchema,
        sql`SELECT * FROM fitness.sleep_session WHERE user_id = ${userId} ORDER BY started_at`,
      ),
  },
  {
    name: "body-measurements.csv",
    query: (db, userId) =>
      executeWithSchema(
        db,
        exportRowSchema,
        sql`SELECT * FROM fitness.body_measurement WHERE user_id = ${userId} ORDER BY recorded_at`,
      ),
  },
  {
    name: "nutrition-daily.csv",
    query: (db, userId) =>
      executeWithSchema(
        db,
        exportRowSchema,
        sql`SELECT * FROM fitness.nutrition_daily WHERE user_id = ${userId} ORDER BY date`,
      ),
  },
  {
    name: "food-entries.csv",
    query: (db, userId) =>
      executeWithSchema(
        db,
        exportRowSchema,
        sql`SELECT * FROM fitness.food_entry WHERE user_id = ${userId} ORDER BY date`,
      ),
  },
  {
    name: "daily-metrics.csv",
    query: (db, userId) =>
      executeWithSchema(
        db,
        exportRowSchema,
        sql`SELECT * FROM fitness.daily_metrics WHERE user_id = ${userId} ORDER BY date`,
      ),
  },
  {
    name: "strength-sets.csv",
    query: (db, userId) =>
      executeWithSchema(
        db,
        exportRowSchema,
        sql`SELECT ss.* FROM fitness.strength_set ss
            JOIN fitness.activity a ON a.id = ss.activity_id
            WHERE a.user_id = ${userId}
            ORDER BY a.started_at, ss.exercise_index, ss.set_index`,
      ),
  },
  {
    name: "lab-panels.csv",
    query: (db, userId) =>
      executeWithSchema(
        db,
        exportRowSchema,
        sql`SELECT * FROM fitness.lab_panel WHERE user_id = ${userId} ORDER BY recorded_at`,
      ),
  },
  {
    name: "lab-results.csv",
    query: (db, userId) =>
      executeWithSchema(
        db,
        exportRowSchema,
        sql`SELECT * FROM fitness.lab_result WHERE user_id = ${userId} ORDER BY recorded_at`,
      ),
  },
  {
    name: "journal-entries.csv",
    query: (db, userId) =>
      executeWithSchema(
        db,
        exportRowSchema,
        sql`SELECT * FROM fitness.journal_entry WHERE user_id = ${userId} ORDER BY date`,
      ),
  },
  {
    name: "life-events.csv",
    query: (db, userId) =>
      executeWithSchema(
        db,
        exportRowSchema,
        sql`SELECT * FROM fitness.life_events WHERE user_id = ${userId} ORDER BY started_at`,
      ),
  },
  {
    name: "health-events.csv",
    query: (db, userId) =>
      executeWithSchema(
        db,
        exportRowSchema,
        sql`SELECT * FROM fitness.health_event WHERE user_id = ${userId} ORDER BY start_date`,
      ),
  },
  {
    name: "sport-settings.csv",
    query: (db, userId) =>
      executeWithSchema(
        db,
        exportRowSchema,
        sql`SELECT * FROM fitness.sport_settings WHERE user_id = ${userId} ORDER BY sport, effective_from`,
      ),
  },
  {
    name: "metric-streams.csv",
    batched: true,
    query: (db, userId) =>
      executeWithSchema(
        db,
        exportRowSchema,
        sql`SELECT * FROM fitness.metric_stream WHERE user_id = ${userId} ORDER BY recorded_at`,
      ),
  },
];

/**
 * Query metric_stream in batches using cursor-based (keyset) pagination and
 * return a Readable stream of CSV content. Unlike OFFSET pagination
 * which re-scans all preceding rows on each page, cursor pagination jumps
 * directly to the next page via the (recorded_at, provider_id, channel) tuple.
 */
function csvHeaders(rows: Record<string, unknown>[]): string[] {
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  return headers;
}

export function csvCell(value: unknown): string {
  if (value == null) return "";
  const serialized =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  if (/[",\n\r]/.test(serialized)) {
    return `"${serialized.replaceAll('"', '""')}"`;
  }
  return serialized;
}

export function rowsToCsv(rows: Record<string, unknown>[]): string {
  const headers = csvHeaders(rows);
  if (headers.length === 0) return "";
  const lines = [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ];
  return lines.join("\n");
}

function createBatchedCsvStream(db: SyncDatabase, userId: string): Readable {
  let cursor:
    | { recordedAt: string; providerId: string; sourceType: string; channel: string }
    | undefined;
  let headers: string[] | undefined;
  let done = false;
  let emittedRows = 0;

  return new Readable({
    async read() {
      if (done) {
        this.push(null);
        return;
      }

      try {
        const cursorCondition = cursor
          ? sql`AND (recorded_at, provider_id, source_type, channel) > (${cursor.recordedAt}::timestamptz, ${cursor.providerId}, ${cursor.sourceType}, ${cursor.channel})`
          : sql``;

        const rows = await executeWithSchema(
          db,
          exportRowSchema,
          sql`SELECT * FROM fitness.metric_stream
              WHERE user_id = ${userId}
              ${cursorCondition}
              ORDER BY recorded_at, provider_id, source_type, channel
              LIMIT ${BATCH_SIZE}`,
        );

        if (!headers) {
          if (rows.length === 0) {
            this.push("");
            done = true;
            this.push(null);
            return;
          }
          headers = csvHeaders(rows);
          this.push(`${headers.map(csvCell).join(",")}\n`);
        }

        for (const row of rows) {
          const prefix = emittedRows === 0 ? "" : "\n";
          this.push(`${prefix}${headers.map((header) => csvCell(row[header])).join(",")}`);
          emittedRows++;
        }

        // Update cursor from last row for next page
        if (rows.length > 0) {
          const lastRow = rows[rows.length - 1];
          if (lastRow) {
            const rawRecordedAt = lastRow.recorded_at;
            cursor = {
              recordedAt:
                rawRecordedAt instanceof Date ? rawRecordedAt.toISOString() : String(rawRecordedAt),
              providerId: String(lastRow.provider_id),
              sourceType: String(lastRow.source_type),
              channel: String(lastRow.channel),
            };
          }
        }

        if (rows.length < BATCH_SIZE) {
          done = true;
          this.push(null);
        }
      } catch (err) {
        this.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
}

/**
 * Generate a full data export ZIP file for the given user.
 */
export async function generateExport(
  db: SyncDatabase,
  userId: string,
  outputPath: string,
  onProgress: (info: ExportProgress) => void,
): Promise<ExportResult> {
  const archive = archiver("zip", { zlib: { level: 6 } });
  const output = createWriteStream(outputPath);

  const finished = new Promise<void>((resolve, reject) => {
    output.on("close", resolve);
    archive.on("error", reject);
    output.on("error", reject);
  });

  archive.pipe(output);

  let totalRecords = 0;
  let tablesProcessed = 0;

  for (const table of EXPORT_TABLES) {
    const percentage = Math.round((tablesProcessed / EXPORT_TABLES.length) * 100);
    onProgress({ percentage, message: `Exporting ${table.name}...` });
    logger.info(`[export] Exporting ${table.name}...`);

    if (table.batched) {
      // Stream metric_stream in batches
      const countResult = await executeWithSchema(
        db,
        countRowSchema,
        sql`SELECT COUNT(*)::text AS count FROM fitness.metric_stream WHERE user_id = ${userId}`,
      );
      const count = parseInt(countResult[0]?.count ?? "0", 10);
      totalRecords += count;

      const stream = createBatchedCsvStream(db, userId);
      archive.append(stream, { name: table.name });
      // Wait for the stream to be consumed by archiver
      await new Promise<void>((resolve, reject) => {
        stream.on("end", resolve);
        stream.on("error", reject);
      });
    } else {
      const rows = await table.query(db, userId);
      totalRecords += rows.length;
      archive.append(rowsToCsv(rows), { name: table.name });
    }

    tablesProcessed++;
  }

  // Add a metadata file
  const metadata = {
    exportedAt: new Date().toISOString(),
    userId,
    tables: EXPORT_TABLES.map((t) => t.name),
    totalRecords,
  };
  archive.append(JSON.stringify(metadata, null, 2), { name: "export-metadata.json" });

  await archive.finalize();
  await finished;

  onProgress({ percentage: 100, message: "Export complete" });
  return { tableCount: EXPORT_TABLES.length, totalRecords };
}
