import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import archiver from "archiver";
import { sql } from "drizzle-orm";
import type { SyncDatabase } from "./db/index.ts";
import { logger } from "./logger.ts";

/** Configuration for a single table to export. */
interface ExportTableConfig {
  /** Filename in the ZIP (e.g., "activities.json") */
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
    name: "user-profile.json",
    query: (db, userId) =>
      db.execute<Record<string, unknown>>(
        sql`SELECT * FROM fitness.user_profile WHERE id = ${userId}`,
      ),
  },
  {
    name: "activities.json",
    query: (db, userId) =>
      db.execute<Record<string, unknown>>(
        sql`SELECT * FROM fitness.activity WHERE user_id = ${userId} ORDER BY started_at`,
      ),
  },
  {
    name: "activity-intervals.json",
    query: (db, userId) =>
      db.execute<Record<string, unknown>>(
        sql`SELECT ai.* FROM fitness.activity_interval ai
            JOIN fitness.activity a ON a.id = ai.activity_id
            WHERE a.user_id = ${userId}
            ORDER BY ai.started_at`,
      ),
  },
  {
    name: "sleep-sessions.json",
    query: (db, userId) =>
      db.execute<Record<string, unknown>>(
        sql`SELECT * FROM fitness.sleep_session WHERE user_id = ${userId} ORDER BY started_at`,
      ),
  },
  {
    name: "body-measurements.json",
    query: (db, userId) =>
      db.execute<Record<string, unknown>>(
        sql`SELECT * FROM fitness.body_measurement WHERE user_id = ${userId} ORDER BY recorded_at`,
      ),
  },
  {
    name: "nutrition-daily.json",
    query: (db, userId) =>
      db.execute<Record<string, unknown>>(
        sql`SELECT * FROM fitness.nutrition_daily WHERE user_id = ${userId} ORDER BY date`,
      ),
  },
  {
    name: "food-entries.json",
    query: (db, userId) =>
      db.execute<Record<string, unknown>>(
        sql`SELECT * FROM fitness.food_entry WHERE user_id = ${userId} ORDER BY date`,
      ),
  },
  {
    name: "daily-metrics.json",
    query: (db, userId) =>
      db.execute<Record<string, unknown>>(
        sql`SELECT * FROM fitness.daily_metrics WHERE user_id = ${userId} ORDER BY date`,
      ),
  },
  {
    name: "strength-workouts.json",
    query: (db, userId) =>
      db.execute<Record<string, unknown>>(
        sql`SELECT * FROM fitness.strength_workout WHERE user_id = ${userId} ORDER BY started_at`,
      ),
  },
  {
    name: "strength-sets.json",
    query: (db, userId) =>
      db.execute<Record<string, unknown>>(
        sql`SELECT ss.* FROM fitness.strength_set ss
            JOIN fitness.strength_workout sw ON sw.id = ss.workout_id
            WHERE sw.user_id = ${userId}
            ORDER BY sw.started_at, ss.exercise_index, ss.set_index`,
      ),
  },
  {
    name: "lab-results.json",
    query: (db, userId) =>
      db.execute<Record<string, unknown>>(
        sql`SELECT * FROM fitness.lab_result WHERE user_id = ${userId} ORDER BY recorded_at`,
      ),
  },
  {
    name: "journal-entries.json",
    query: (db, userId) =>
      db.execute<Record<string, unknown>>(
        sql`SELECT * FROM fitness.journal_entry WHERE user_id = ${userId} ORDER BY date`,
      ),
  },
  {
    name: "life-events.json",
    query: (db, userId) =>
      db.execute<Record<string, unknown>>(
        sql`SELECT * FROM fitness.life_events WHERE user_id = ${userId} ORDER BY started_at`,
      ),
  },
  {
    name: "health-events.json",
    query: (db, userId) =>
      db.execute<Record<string, unknown>>(
        sql`SELECT * FROM fitness.health_event WHERE user_id = ${userId} ORDER BY start_date`,
      ),
  },
  {
    name: "sport-settings.json",
    query: (db, userId) =>
      db.execute<Record<string, unknown>>(
        sql`SELECT * FROM fitness.sport_settings WHERE user_id = ${userId} ORDER BY sport, effective_from`,
      ),
  },
  {
    name: "metric-streams.json",
    batched: true,
    query: (db, userId) =>
      db.execute<Record<string, unknown>>(
        sql`SELECT * FROM fitness.metric_stream WHERE user_id = ${userId} ORDER BY recorded_at`,
      ),
  },
];

/**
 * Query metric_stream in batches and return a Readable stream of JSON array content.
 * This avoids loading the entire table into memory.
 */
function createBatchedJsonStream(db: SyncDatabase, userId: string): Readable {
  let offset = 0;
  let started = false;
  let done = false;

  return new Readable({
    async read() {
      if (done) {
        this.push(null);
        return;
      }

      try {
        const rows = await db.execute<Record<string, unknown>>(
          sql`SELECT * FROM fitness.metric_stream
              WHERE user_id = ${userId}
              ORDER BY recorded_at
              LIMIT ${BATCH_SIZE} OFFSET ${offset}`,
        );

        if (!started) {
          started = true;
          if (rows.length === 0) {
            this.push("[]");
            done = true;
            this.push(null);
            return;
          }
          this.push("[\n");
        }

        for (let i = 0; i < rows.length; i++) {
          const prefix = offset === 0 && i === 0 ? "" : ",\n";
          this.push(prefix + JSON.stringify(rows[i]));
        }

        offset += rows.length;

        if (rows.length < BATCH_SIZE) {
          this.push("\n]");
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
      const countResult = await db.execute<{ count: string }>(
        sql`SELECT COUNT(*)::text AS count FROM fitness.metric_stream WHERE user_id = ${userId}`,
      );
      const count = parseInt(countResult[0]?.count ?? "0", 10);
      totalRecords += count;

      const stream = createBatchedJsonStream(db, userId);
      archive.append(stream, { name: table.name });
      // Wait for the stream to be consumed by archiver
      await new Promise<void>((resolve, reject) => {
        stream.on("end", resolve);
        stream.on("error", reject);
      });
    } else {
      const rows = await table.query(db, userId);
      totalRecords += rows.length;
      archive.append(JSON.stringify(rows, null, 2), { name: table.name });
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
