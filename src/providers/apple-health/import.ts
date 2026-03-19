import { createReadStream, createWriteStream, mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, gte } from "drizzle-orm";
import sax from "sax";
import yauzl from "yauzl";
import type { SyncDatabase } from "../../db/index.ts";
import { healthEvent, labResult, metricStream } from "../../db/schema.ts";
import { ensureProvider } from "../../db/tokens.ts";
import { logger } from "../../logger.ts";
import type { SyncError, SyncResult } from "../types.ts";
import { getStringAttrs } from "./dates.ts";
import {
  ALL_ROUTED_TYPES,
  BODY_MEASUREMENT_TYPES,
  DAILY_METRIC_TYPES,
  METRIC_STREAM_TYPES,
  NUTRITION_TYPES,
  upsertBodyMeasurementBatch,
  upsertDailyMetricsBatch,
  upsertHealthEventBatch,
  linkUnassignedHeartRateToActivities,
  upsertMetricStreamBatch,
  upsertNutritionBatch,
  upsertSleepBatch,
  upsertWorkoutBatch,
} from "./db-insertion.ts";
import {
  buildPanelMap,
  type FhirDiagnosticReport,
  type FhirObservation,
  fhirResourceSchema,
  parseFhirObservation,
} from "./fhir.ts";
import type { HealthRecord } from "./records.ts";
import type { ProgressInfo } from "./streaming.ts";
import { streamHealthExport } from "./streaming.ts";

/**
 * Extract export.xml from an Apple Health export ZIP file.
 * Returns the path to the extracted XML file in a temp directory.
 */
export function extractExportXml(zipPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const outDir = join(tmpdir(), `apple-health-import-${Date.now()}`);
    mkdirSync(outDir, { recursive: true });

    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error("Failed to open ZIP"));

      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        // Look for export.xml (may be in apple_health_export/ subdirectory)
        if (entry.fileName.endsWith("export.xml")) {
          zipfile.openReadStream(entry, (err2, readStream) => {
            if (err2 || !readStream) return reject(err2 ?? new Error("Failed to read entry"));
            const outPath = join(outDir, "export.xml");
            const writeStream = createWriteStream(outPath);
            readStream.pipe(writeStream);
            writeStream.on("finish", () => resolve(outPath));
            writeStream.on("error", reject);
          });
        } else {
          zipfile.readEntry();
        }
      });

      zipfile.on("end", () => {
        reject(new Error("No export.xml found in ZIP file"));
      });
      zipfile.on("error", reject);
    });
  });
}

// ============================================================
// Default console progress reporter
// ============================================================

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function defaultConsoleProgress(info: ProgressInfo): void {
  const bar =
    "\u2588".repeat(Math.floor(info.pct / 2)) + "\u2591".repeat(50 - Math.floor(info.pct / 2));
  process.stderr.write(
    `\r[apple_health] ${bar} ${info.pct}% ` +
      `(${formatBytes(info.bytesRead)}/${formatBytes(info.totalBytes)}) ` +
      `${info.recordCount} records, ${info.workoutCount} workouts, ${info.sleepCount} sleep`,
  );
  if (info.pct >= 100) {
    process.stderr.write("\n");
  }
}

// ============================================================
// Import logic (shared between CLI and sync)
// ============================================================

export async function runImport(
  db: SyncDatabase,
  providerId: string,
  xmlPath: string,
  since: Date,
  onProgress?: (info: ProgressInfo) => void,
): Promise<SyncResult> {
  const start = Date.now();
  const errors: SyncError[] = [];
  let recordsSynced = 0;

  try {
    // Delete existing metric_stream rows for this provider/time range so re-imports
    // don't create duplicates (metric_stream has no unique constraint).
    await db
      .delete(metricStream)
      .where(and(eq(metricStream.providerId, providerId), gte(metricStream.recordedAt, since)));

    const counts = await streamHealthExport(xmlPath, since, {
      onProgress,
      onRecordBatch: async (records) => {
        // Single-pass classification instead of 5 separate .filter() calls
        const metricRecords: HealthRecord[] = [];
        const bodyRecords: HealthRecord[] = [];
        const dailyRecords: HealthRecord[] = [];
        const nutritionRecords: HealthRecord[] = [];
        const unrouted: HealthRecord[] = [];
        for (const r of records) {
          if (METRIC_STREAM_TYPES[r.type]) metricRecords.push(r);
          else if (BODY_MEASUREMENT_TYPES.has(r.type)) bodyRecords.push(r);
          else if (DAILY_METRIC_TYPES.has(r.type)) dailyRecords.push(r);
          else if (NUTRITION_TYPES[r.type]) nutritionRecords.push(r);
          else if (!ALL_ROUTED_TYPES.has(r.type)) unrouted.push(r);
        }

        // Run all table inserts in parallel -- they target independent tables
        const results = await Promise.all([
          metricRecords.length > 0 ? upsertMetricStreamBatch(db, providerId, metricRecords) : 0,
          bodyRecords.length > 0 ? upsertBodyMeasurementBatch(db, providerId, bodyRecords) : 0,
          dailyRecords.length > 0 ? upsertDailyMetricsBatch(db, providerId, dailyRecords) : 0,
          nutritionRecords.length > 0 ? upsertNutritionBatch(db, providerId, nutritionRecords) : 0,
          unrouted.length > 0 ? upsertHealthEventBatch(db, providerId, unrouted) : 0,
        ]);
        for (const c of results) recordsSynced += c;
      },
      onSleepBatch: async (records) => {
        const c = await upsertSleepBatch(db, providerId, records);
        recordsSynced += c;
      },
      onWorkoutBatch: async (workouts) => {
        const c = await upsertWorkoutBatch(db, providerId, workouts);
        recordsSynced += c;
      },
      onCategoryBatch: async (records) => {
        // Insert category records into health_event table
        const rows: (typeof healthEvent.$inferInsert)[] = records.map((r) => ({
          providerId,
          externalId: `ah:${r.type}:${r.startDate.toISOString()}`,
          type: r.type,
          valueText: r.value || undefined,
          sourceName: r.sourceName,
          startDate: r.startDate,
          endDate: r.endDate,
        }));
        for (let i = 0; i < rows.length; i += 500) {
          await db
            .insert(healthEvent)
            .values(rows.slice(i, i + 500))
            .onConflictDoNothing();
        }
        recordsSynced += rows.length;
      },
    });

    const linkedHrRows = await linkUnassignedHeartRateToActivities(db, providerId, {
      startAt: since,
    });
    if (linkedHrRows > 0) {
      logger.info(
        `[apple_health] Linked ${linkedHrRows} heart-rate metric rows to workouts after import`,
      );
    }

    logger.info(
      `[apple_health] Parsed ${counts.recordCount} records, ` +
        `${counts.workoutCount} workouts, ${counts.sleepCount} sleep records, ` +
        `${counts.categoryCount} category events`,
    );
  } catch (err) {
    errors.push({
      message: err instanceof Error ? err.message : String(err),
      cause: err,
    });
  }

  return { provider: providerId, recordsSynced, errors, duration: Date.now() - start };
}

/**
 * Import from a file path -- accepts either a .zip or .xml file.
 */
export async function importAppleHealthFile(
  db: SyncDatabase,
  filePath: string,
  since: Date,
  onProgress?: (info: ProgressInfo) => void,
): Promise<SyncResult> {
  await ensureProvider(db, "apple_health", "Apple Health");

  let xmlPath: string;
  let cleanupPath: string | null = null;

  if (filePath.endsWith(".zip")) {
    logger.info(`[apple_health] Extracting ${filePath}...`);
    xmlPath = await extractExportXml(filePath);
    cleanupPath = xmlPath;
    logger.info(`[apple_health] Extracted to ${xmlPath}`);
  } else {
    xmlPath = filePath;
  }

  // Default to console progress if no callback provided
  const progressFn = onProgress ?? defaultConsoleProgress;

  logger.info(`[apple_health] Importing from ${xmlPath} (since ${since.toISOString()})`);
  const result = await runImport(db, "apple_health", xmlPath, since, progressFn);

  // Import clinical records (lab results) from zip
  if (filePath.endsWith(".zip")) {
    logger.info("[apple_health] Importing clinical records...");
    const labCounts = await importClinicalRecords(db, "apple_health", filePath, xmlPath);
    result.recordsSynced += labCounts.inserted;
    if (labCounts.errors.length > 0) {
      result.errors.push(...labCounts.errors);
    }
    logger.info(
      `[apple_health] ${labCounts.inserted} lab results, ` +
        `${labCounts.skipped} skipped, ${labCounts.errors.length} errors`,
    );
  }

  // Clean up extracted temp file
  if (cleanupPath) {
    try {
      const { rmSync: rm } = await import("node:fs");
      const { dirname: dir } = await import("node:path");
      rm(dir(cleanupPath), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  return result;
}

// ============================================================
// Clinical records import from ZIP
// ============================================================

export function readZipEntries(
  zipPath: string,
  match: (name: string) => boolean,
): Promise<{ name: string; data: Buffer }[]> {
  return new Promise((resolve, reject) => {
    const results: { name: string; data: Buffer }[] = [];
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error("Failed to open ZIP"));

      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        if (match(entry.fileName)) {
          zipfile.openReadStream(entry, (err2, stream) => {
            if (err2 || !stream) {
              zipfile.readEntry();
              return;
            }
            const chunks: Buffer[] = [];
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("end", () => {
              results.push({ name: entry.fileName, data: Buffer.concat(chunks) });
              zipfile.readEntry();
            });
            stream.on("error", () => zipfile.readEntry());
          });
        } else {
          zipfile.readEntry();
        }
      });

      zipfile.on("end", () => resolve(results));
      zipfile.on("error", reject);
    });
  });
}

/**
 * Stream the on-disk export.xml with SAX, extracting only <ClinicalRecord>
 * sourceName -> resourceFilePath mappings. This avoids loading the full
 * 2.5GB XML into memory.
 */
export function buildSourceNameMap(xmlPath: string): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const map = new Map<string, string>();
    const parser = sax.createStream(true, { trim: true });

    parser.on("opentag", (node) => {
      if (node.name === "ClinicalRecord") {
        const attrs = getStringAttrs(node);
        const sourceName: string | undefined = attrs.sourceName;
        const resourcePath: string | undefined = attrs.resourceFilePath;
        if (sourceName && resourcePath) {
          map.set(resourcePath.replace(/^\//, ""), sourceName);
        }
      }
    });

    parser.on("end", () => resolve(map));
    parser.on("error", (err) => reject(err));

    createReadStream(xmlPath, { encoding: "utf8" }).pipe(parser);
  });
}

export async function importClinicalRecords(
  db: SyncDatabase,
  providerId: string,
  zipPath: string,
  xmlPath: string,
): Promise<{ inserted: number; skipped: number; errors: SyncError[] }> {
  const errors: SyncError[] = [];

  // Read all FHIR JSON files from the zip
  const clinicalFiles = await readZipEntries(
    zipPath,
    (name) => name.includes("clinical-records/") && name.endsWith(".json"),
  );

  if (clinicalFiles.length === 0) {
    return { inserted: 0, skipped: 0, errors };
  }

  // Parse files, separating Observations from DiagnosticReports
  const observations: { obs: FhirObservation; fileName: string }[] = [];
  const diagnosticReports: FhirDiagnosticReport[] = [];
  let skipped = 0;

  for (const file of clinicalFiles) {
    try {
      const raw: unknown = JSON.parse(file.data.toString("utf-8"));
      const result = fhirResourceSchema.safeParse(raw);
      if (!result.success) {
        skipped++;
        continue;
      }
      if (result.data.resourceType === "Observation") {
        observations.push({ obs: result.data, fileName: file.name });
      } else {
        diagnosticReports.push(result.data);
      }
    } catch (err) {
      errors.push({
        message: `Failed to parse ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Build panel map from DiagnosticReports
  const panelMap = buildPanelMap(diagnosticReports);

  // Build source name map from XML stubs
  const sourceNameMap = await buildSourceNameMap(xmlPath);

  // Parse and insert Observations
  let inserted = 0;
  const batch: (typeof labResult.$inferInsert)[] = [];

  for (const { obs, fileName } of observations) {
    // Only import lab results (skip vitals, etc.)
    const categories = Array.isArray(obs.category)
      ? obs.category
      : obs.category
        ? [obs.category]
        : [];
    const isLab = categories.some((cat) =>
      cat.coding?.some((c) => c.code === "laboratory" || c.code === "LAB"),
    );
    if (!isLab) {
      skipped++;
      continue;
    }

    try {
      const normalizedPath = fileName.replace(/^apple_health_export\//, "");
      const sourceName = sourceNameMap.get(normalizedPath) ?? "Unknown";
      const parsed = parseFhirObservation(obs, sourceName);
      const panelName = panelMap.get(obs.id);

      batch.push({
        providerId,
        externalId: parsed.externalId,
        testName: parsed.testName,
        loincCode: parsed.loincCode,
        value: parsed.value,
        valueText: parsed.valueText,
        unit: parsed.unit,
        referenceRangeLow: parsed.referenceRangeLow,
        referenceRangeHigh: parsed.referenceRangeHigh,
        referenceRangeText: parsed.referenceRangeText,
        panelName,
        status: parsed.status,
        sourceName: parsed.sourceName,
        recordedAt: parsed.recordedAt,
        issuedAt: parsed.issuedAt,
        raw: parsed.raw,
      });

      if (batch.length >= 500) {
        await db.insert(labResult).values(batch).onConflictDoNothing();
        inserted += batch.length;
        batch.length = 0;
      }
    } catch (err) {
      errors.push({
        message: `Observation ${obs.id}: ${err instanceof Error ? err.message : String(err)}`,
        externalId: obs.id,
      });
    }
  }

  if (batch.length > 0) {
    await db.insert(labResult).values(batch).onConflictDoNothing();
    inserted += batch.length;
  }

  return { inserted, skipped, errors };
}

/**
 * Find the latest Apple Health export file in the given directory.
 */
export function findLatestExport(): string | null {
  const dir = process.env.APPLE_HEALTH_IMPORT_DIR;
  if (!dir) return null;

  try {
    // Look for both .xml and .zip files
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".xml") || f.endsWith(".zip"))
      .map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    const latest = files[0];
    return latest ? join(dir, latest.name) : null;
  } catch {
    return null;
  }
}
