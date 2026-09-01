import { createWriteStream } from "node:fs";
import { ZipArchive } from "archiver";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { SyncDatabase } from "./db/index.ts";
import { executeWithSchema } from "./lib/typed-sql.ts";
import { logger } from "./logger.ts";

const exportRowSchema = z.record(z.string(), z.unknown());

/** Configuration for a single table to export. */
interface ExportTableConfig {
  /** Filename in the ZIP (e.g., "activities.csv") */
  name: string;
  /** SQL query that returns all rows for the given user */
  query: (db: SyncDatabase, userId: string) => Promise<Record<string, unknown>[]>;
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
        sql`SELECT * FROM fitness.activity
            WHERE user_id = ${userId}
              AND provider_absent_at IS NULL
              AND deleted_at IS NULL
            ORDER BY started_at`,
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
              AND a.provider_absent_at IS NULL
              AND a.deleted_at IS NULL
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
    name: "breathwork-sessions.csv",
    query: (db, userId) =>
      executeWithSchema(
        db,
        exportRowSchema,
        sql`SELECT * FROM fitness.breathwork_session WHERE user_id = ${userId} ORDER BY started_at`,
      ),
  },
  {
    name: "nutrition-daily.csv",
    query: (db, userId) =>
      executeWithSchema(
        db,
        exportRowSchema,
        sql`SELECT * FROM fitness.v_nutrition_provider_daily WHERE user_id = ${userId} ORDER BY date`,
      ),
  },
  {
    name: "food-entries.csv",
    query: (db, userId) =>
      executeWithSchema(
        db,
        exportRowSchema,
        sql`SELECT * FROM fitness.food_entry WHERE user_id = ${userId} ORDER BY date, created_at`,
      ),
  },
  {
    name: "food-entry-nutrients.csv",
    query: (db, userId) =>
      executeWithSchema(
        db,
        exportRowSchema,
        sql`SELECT fen.*
            FROM fitness.food_entry_nutrient fen
            JOIN fitness.food_entry fe ON fe.id = fen.food_entry_id
            WHERE fe.user_id = ${userId}
            ORDER BY fe.date, fen.nutrient_id`,
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
              AND a.provider_absent_at IS NULL
              AND a.deleted_at IS NULL
            ORDER BY a.started_at, ss.exercise_index, ss.set_index`,
      ),
  },
  {
    name: "clinical-records.csv",
    query: (db, userId) =>
      executeWithSchema(
        db,
        exportRowSchema,
        sql`SELECT * FROM fitness.clinical_record WHERE user_id = ${userId} ORDER BY downloaded_at`,
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
    name: "menstrual-periods.csv",
    query: (db, userId) =>
      executeWithSchema(
        db,
        exportRowSchema,
        sql`SELECT * FROM fitness.menstrual_period WHERE user_id = ${userId} ORDER BY start_date`,
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
];

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

/**
 * Generate a full data export ZIP file for the given user.
 */
export async function generateExport(
  db: SyncDatabase,
  userId: string,
  outputPath: string,
  onProgress: (info: ExportProgress) => void,
): Promise<ExportResult> {
  const archive = new ZipArchive({ zlib: { level: 6 } });
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

    const rows = await table.query(db, userId);
    totalRecords += rows.length;
    archive.append(rowsToCsv(rows), { name: table.name });

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
