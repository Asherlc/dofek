import { createReadStream, createWriteStream, mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, gte, sql } from "drizzle-orm";
import sax from "sax";
import yauzl from "yauzl";
import { z } from "zod";
import type { SyncDatabase } from "../../db/index.ts";
import { replaceMetricStreamBatch } from "../../db/metric-stream-writer.ts";
import { finishProviderActivityListSync } from "../../db/provider-activity-sync.ts";
import { dailyMetrics } from "../../db/schema/activity.ts";
import {
  allergyIntolerance,
  condition,
  healthEvent,
  labPanel,
  labResult,
  medication,
  medicationDoseEvent,
} from "../../db/schema/clinical.ts";
import { foodEntry } from "../../db/schema/nutrition.ts";
import { SOURCE_TYPE_FILE } from "../../db/sensor-channels.ts";
import { getTokenUserId } from "../../db/token-user-context.ts";
import { ensureProvider } from "../../db/tokens.ts";
import { logger } from "../../logger.ts";
import type { MetricStreamEventPublisher } from "../../metric-stream/redpanda-producer.ts";
import type { SyncError, SyncResult } from "../types.ts";
import { getStringAttrs } from "./dates.ts";
import {
  ALL_ROUTED_TYPES,
  aggregateSkinTempToDailyMetrics,
  aggregateSpO2ToDailyMetrics,
  BODY_MEASUREMENT_TYPES,
  DAILY_METRIC_TYPES,
  METRIC_STREAM_TYPES,
  NUTRITION_TYPES,
  upsertBodyMeasurementBatch,
  upsertDailyMetricsBatch,
  upsertHealthEventBatch,
  upsertMetricStreamBatch,
  upsertNutritionBatch,
  upsertSleepBatch,
  upsertWorkoutBatch,
} from "./db-insertion.ts";
import {
  type FhirAllergyIntolerance,
  type FhirCondition,
  type FhirDiagnosticReport,
  type FhirMedicationRequest,
  type FhirObservation,
  fhirResourceSchema,
  parseFhirAllergyIntolerance,
  parseFhirCondition,
  parseFhirDiagnosticReport,
  parseFhirMedicationRequest,
  parseFhirObservation,
} from "./fhir.ts";
import type { HealthRecord } from "./records.ts";
import type { ProgressInfo } from "./streaming.ts";
import { streamHealthExport } from "./streaming.ts";

const appleMedicationDoseEventSchema = z
  .object({
    uuid: z.string().optional(),
    startDate: z.string(),
    scheduledDate: z.string().nullable().optional(),
    logStatus: z.union([z.number(), z.string()]).optional(),
    medicationConceptIdentifier: z.string().nullable().optional(),
    medicationDisplayName: z.string().nullable().optional(),
    sourceName: z.string().nullable().optional(),
  })
  .passthrough();

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function parseMedicationDoseRecordedAt(value: string): Date {
  const recordedAt = new Date(value);
  if (Number.isNaN(recordedAt.getTime())) {
    throw new Error(`Invalid medication dose event startDate: ${value}`);
  }
  return recordedAt;
}

function mapMedicationDoseStatus(logStatus: number | string | undefined): string {
  if (logStatus === 1 || logStatus === "1") return "taken";
  if (logStatus === 2 || logStatus === "2") return "skipped";
  const statusText = typeof logStatus === "string" ? normalizeOptionalString(logStatus) : null;
  return statusText ?? "unknown";
}

function medicationDoseEventName(input: {
  medicationConceptIdentifier?: string | null | undefined;
  medicationDisplayName?: string | null | undefined;
}): string {
  return (
    normalizeOptionalString(input.medicationDisplayName) ??
    normalizeOptionalString(input.medicationConceptIdentifier) ??
    "Unknown medication"
  );
}

function medicationDoseEventExternalId(input: {
  medicationConceptIdentifier?: string | null | undefined;
  medicationName: string;
  scheduledDate?: string | null | undefined;
  sourceFileName: string;
  startDate: string;
  uuid?: string | null | undefined;
}): string {
  const uuid = normalizeOptionalString(input.uuid);
  if (uuid) return uuid;

  return [
    "apple-health-medication-dose",
    input.startDate,
    normalizeOptionalString(input.scheduledDate) ?? "unscheduled",
    normalizeOptionalString(input.medicationConceptIdentifier) ?? input.medicationName,
    input.sourceFileName,
  ].join(":");
}

function medicationDoseEventConflictKey(row: typeof medicationDoseEvent.$inferInsert): string {
  return `${row.userId}:${row.providerId}:${row.externalId}`;
}

function hasDuplicateMedicationDoseConflictKeys(
  rows: Array<typeof medicationDoseEvent.$inferInsert>,
): boolean {
  const keys = new Set<string>();
  for (const row of rows) {
    const key = medicationDoseEventConflictKey(row);
    if (keys.has(key)) return true;
    keys.add(key);
  }
  return false;
}

/**
 * Extract export.xml from an Apple Health export ZIP file.
 * Returns the path to the extracted XML file in a temp directory.
 */
export class AppleHealthImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleHealthImportValidationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

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
        reject(
          new AppleHealthImportValidationError(
            "Apple Health ZIP must contain export.xml; upload the original Apple Health export archive",
          ),
        );
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
    "\u2588".repeat(Math.floor(info.percentage / 2)) +
    "\u2591".repeat(50 - Math.floor(info.percentage / 2));
  process.stderr.write(
    `\r[apple_health] ${bar} ${info.percentage}% ` +
      `(${formatBytes(info.bytesRead)}/${formatBytes(info.totalBytes)}) ` +
      `${info.recordCount} records, ${info.workoutCount} workouts, ${info.sleepCount} sleep`,
  );
  if (info.percentage >= 100) {
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
  metricStreamPublisher?: MetricStreamEventPublisher,
): Promise<SyncResult> {
  const start = Date.now();
  const errors: SyncError[] = [];
  let recordsSynced = 0;
  const presentWorkoutExternalIds = new Set<string>();
  let latestWorkoutTimestamp: Date | null = null;
  const scopedUserId = getTokenUserId();
  if (!scopedUserId) {
    throw new Error("apple-health import requires user context");
  }

  try {
    // Delete existing rows for this provider/time range so re-imports don't
    // create duplicate metric stream samples and additive
    // daily metric upserts don't double-count across re-imports.
    const sinceDate = sql`${since.toISOString().slice(0, 10)}::date`;
    const metricStreamReplacementScope = {
      userId: scopedUserId,
      providerId,
      recordedAtStart: since,
    };
    await replaceMetricStreamBatch(
      db,
      metricStreamReplacementScope,
      [],
      SOURCE_TYPE_FILE,
      metricStreamPublisher,
    );
    await db
      .delete(dailyMetrics)
      .where(
        and(
          eq(dailyMetrics.userId, scopedUserId),
          eq(dailyMetrics.providerId, providerId),
          gte(dailyMetrics.date, sinceDate),
        ),
      );
    await db
      .delete(foodEntry)
      .where(
        and(
          eq(foodEntry.userId, scopedUserId),
          eq(foodEntry.providerId, providerId),
          gte(foodEntry.date, sinceDate),
        ),
      );

    const dailyAggregateMetricRecords: HealthRecord[] = [];
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
          metricRecords.length > 0
            ? upsertMetricStreamBatch(
                db,
                providerId,
                metricRecords,
                metricStreamReplacementScope,
                metricStreamPublisher,
              )
            : 0,
          bodyRecords.length > 0
            ? upsertBodyMeasurementBatch(
                db,
                providerId,
                bodyRecords,
                metricStreamReplacementScope,
                metricStreamPublisher,
              )
            : 0,
          dailyRecords.length > 0 ? upsertDailyMetricsBatch(db, providerId, dailyRecords) : 0,
          nutritionRecords.length > 0 ? upsertNutritionBatch(db, providerId, nutritionRecords) : 0,
          unrouted.length > 0 ? upsertHealthEventBatch(db, providerId, unrouted) : 0,
        ]);
        dailyAggregateMetricRecords.push(...metricRecords);
        for (const c of results) recordsSynced += c;
      },
      onSleepBatch: async (records) => {
        const sleepCount = await upsertSleepBatch(db, providerId, records);
        recordsSynced += sleepCount;
      },
      onWorkoutBatch: async (workouts) => {
        for (const workout of workouts) {
          presentWorkoutExternalIds.add(`ah:workout:${workout.startDate.toISOString()}`);
          const workoutEnd = workout.endDate ?? workout.startDate;
          if (!latestWorkoutTimestamp || workoutEnd > latestWorkoutTimestamp) {
            latestWorkoutTimestamp = workoutEnd;
          }
        }
        const workoutCount = await upsertWorkoutBatch(
          db,
          providerId,
          workouts,
          metricStreamReplacementScope,
          metricStreamPublisher,
        );
        recordsSynced += workoutCount;
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

    if (dailyAggregateMetricRecords.length > 0) {
      await aggregateSpO2ToDailyMetrics(db, providerId, dailyAggregateMetricRecords);
      await aggregateSkinTempToDailyMetrics(db, providerId, dailyAggregateMetricRecords);
    }

    await finishProviderActivityListSync(db, {
      providerId,
      userId: scopedUserId,
      windowStart: since,
      windowEnd: latestWorkoutTimestamp ?? since,
      presentExternalIds: presentWorkoutExternalIds,
    });

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
  metricStreamPublisher?: MetricStreamEventPublisher,
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
  const result = await runImport(
    db,
    "apple_health",
    xmlPath,
    since,
    progressFn,
    metricStreamPublisher,
  );

  // Import clinical records (lab results) from zip
  if (filePath.endsWith(".zip")) {
    logger.info("[apple_health] Importing clinical records...");
    const labCounts = await importClinicalRecords(db, "apple_health", filePath, xmlPath);
    result.recordsSynced += labCounts.inserted;
    if (labCounts.errors.length > 0) {
      result.errors.push(...labCounts.errors);
    }
    logger.info(
      `[apple_health] ${labCounts.inserted} clinical records imported, ` +
        `${labCounts.skipped} skipped, ${labCounts.errors.length} errors`,
    );

    logger.info("[apple_health] Importing medication dose events...");
    const doseEventCounts = await importMedicationDoseEvents(db, "apple_health", filePath);
    result.recordsSynced += doseEventCounts.inserted;
    if (doseEventCounts.errors.length > 0) {
      result.errors.push(...doseEventCounts.errors);
    }
    logger.info(
      `[apple_health] ${doseEventCounts.inserted} medication dose events imported, ` +
        `${doseEventCounts.skipped} skipped, ${doseEventCounts.errors.length} errors`,
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
  const scopedUserId = getTokenUserId();
  if (!scopedUserId) {
    throw new Error("apple-health clinical import requires user context");
  }

  // Delete existing clinical records for this provider so re-imports
  // don't create duplicate panels (lab_result FK references lab_panel,
  // so lab_result must be deleted first).
  await db
    .delete(labResult)
    .where(and(eq(labResult.userId, scopedUserId), eq(labResult.providerId, providerId)));
  await db
    .delete(labPanel)
    .where(and(eq(labPanel.userId, scopedUserId), eq(labPanel.providerId, providerId)));
  await db
    .delete(medication)
    .where(and(eq(medication.userId, scopedUserId), eq(medication.providerId, providerId)));
  await db
    .delete(condition)
    .where(and(eq(condition.userId, scopedUserId), eq(condition.providerId, providerId)));
  await db
    .delete(allergyIntolerance)
    .where(
      and(
        eq(allergyIntolerance.userId, scopedUserId),
        eq(allergyIntolerance.providerId, providerId),
      ),
    );

  // Read all FHIR JSON files from the zip
  const clinicalFiles = await readZipEntries(
    zipPath,
    (name) => name.includes("clinical-records/") && name.endsWith(".json"),
  );

  if (clinicalFiles.length === 0) {
    return { inserted: 0, skipped: 0, errors };
  }

  // Parse files, separating by resource type
  const observations: { obs: FhirObservation; fileName: string }[] = [];
  const diagnosticReports: FhirDiagnosticReport[] = [];
  const medicationRequests: { resource: FhirMedicationRequest; fileName: string }[] = [];
  const conditions: { resource: FhirCondition; fileName: string }[] = [];
  const allergies: { resource: FhirAllergyIntolerance; fileName: string }[] = [];
  let skipped = 0;

  for (const file of clinicalFiles) {
    try {
      const raw: unknown = JSON.parse(file.data.toString("utf-8"));
      const result = fhirResourceSchema.safeParse(raw);
      if (!result.success) {
        skipped++;
        continue;
      }
      switch (result.data.resourceType) {
        case "Observation":
          observations.push({ obs: result.data, fileName: file.name });
          break;
        case "DiagnosticReport":
          diagnosticReports.push(result.data);
          break;
        case "MedicationRequest":
          medicationRequests.push({ resource: result.data, fileName: file.name });
          break;
        case "Condition":
          conditions.push({ resource: result.data, fileName: file.name });
          break;
        case "AllergyIntolerance":
          allergies.push({ resource: result.data, fileName: file.name });
          break;
      }
    } catch (err) {
      errors.push({
        message: `Failed to parse ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Build source name map from XML stubs
  const sourceNameMap = await buildSourceNameMap(xmlPath);

  // Insert lab panels from DiagnosticReports
  const panelBatch: (typeof labPanel.$inferInsert)[] = [];
  const observationToPanelExternalId = new Map<string, string>();

  for (const report of diagnosticReports) {
    try {
      const sourceName = "Unknown"; // DiagnosticReports don't have individual file paths
      const parsed = parseFhirDiagnosticReport(report, sourceName);

      panelBatch.push({
        providerId,
        externalId: parsed.externalId,
        name: parsed.name,
        loincCode: parsed.loincCode,
        status: parsed.status,
        sourceName: parsed.sourceName,
        recordedAt: parsed.recordedAt,
        issuedAt: parsed.issuedAt,
        raw: parsed.raw,
      });

      for (const obsId of parsed.observationIds) {
        observationToPanelExternalId.set(obsId, parsed.externalId);
      }
    } catch (err) {
      errors.push({
        message: `DiagnosticReport ${report.id}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  for (let i = 0; i < panelBatch.length; i += 500) {
    await db
      .insert(labPanel)
      .values(panelBatch.slice(i, i + 500))
      .onConflictDoNothing();
  }

  // Query back panel IDs so we can link lab results via FK
  const panelIdMap = new Map<string, string>();
  if (panelBatch.length > 0) {
    const panelRows = await db
      .select({ id: labPanel.id, externalId: labPanel.externalId })
      .from(labPanel)
      .where(and(eq(labPanel.userId, scopedUserId), eq(labPanel.providerId, providerId)));
    for (const row of panelRows) {
      if (row.externalId) {
        panelIdMap.set(row.externalId, row.id);
      }
    }
  }

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

      // Resolve panel FK: obs FHIR ID -> panel external ID -> panel DB UUID
      const panelExternalId = observationToPanelExternalId.get(obs.id);
      const panelId = panelExternalId ? panelIdMap.get(panelExternalId) : undefined;

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
        panelId,
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

  // Insert medications from MedicationRequests
  const medicationBatch: (typeof medication.$inferInsert)[] = [];
  for (const { resource, fileName } of medicationRequests) {
    try {
      const normalizedPath = fileName.replace(/^apple_health_export\//, "");
      const sourceName = sourceNameMap.get(normalizedPath) ?? "Unknown";
      const parsed = parseFhirMedicationRequest(resource, sourceName);
      medicationBatch.push({
        providerId,
        externalId: parsed.externalId,
        name: parsed.name,
        status: parsed.status,
        authoredOn: parsed.authoredOn,
        startDate: parsed.startDate,
        endDate: parsed.endDate,
        dosageText: parsed.dosageText,
        route: parsed.route,
        form: parsed.form,
        rxnormCode: parsed.rxnormCode,
        prescriberName: parsed.prescriberName,
        reasonText: parsed.reasonText,
        reasonSnomedCode: parsed.reasonSnomedCode,
        sourceName: parsed.sourceName,
        raw: parsed.raw,
      });
    } catch (err) {
      errors.push({
        message: `MedicationRequest ${resource.id}: ${err instanceof Error ? err.message : String(err)}`,
        externalId: resource.id,
      });
    }
  }
  for (let i = 0; i < medicationBatch.length; i += 500) {
    await db
      .insert(medication)
      .values(medicationBatch.slice(i, i + 500))
      .onConflictDoNothing();
  }
  inserted += medicationBatch.length;

  // Insert conditions
  const conditionBatch: (typeof condition.$inferInsert)[] = [];
  for (const { resource, fileName } of conditions) {
    try {
      const normalizedPath = fileName.replace(/^apple_health_export\//, "");
      const sourceName = sourceNameMap.get(normalizedPath) ?? "Unknown";
      const parsed = parseFhirCondition(resource, sourceName);
      conditionBatch.push({
        providerId,
        externalId: parsed.externalId,
        name: parsed.name,
        clinicalStatus: parsed.clinicalStatus,
        verificationStatus: parsed.verificationStatus,
        icd10Code: parsed.icd10Code,
        snomedCode: parsed.snomedCode,
        onsetDate: parsed.onsetDate,
        abatementDate: parsed.abatementDate,
        recordedDate: parsed.recordedDate,
        sourceName: parsed.sourceName,
        raw: parsed.raw,
      });
    } catch (err) {
      errors.push({
        message: `Condition ${resource.id}: ${err instanceof Error ? err.message : String(err)}`,
        externalId: resource.id,
      });
    }
  }
  for (let i = 0; i < conditionBatch.length; i += 500) {
    await db
      .insert(condition)
      .values(conditionBatch.slice(i, i + 500))
      .onConflictDoNothing();
  }
  inserted += conditionBatch.length;

  // Insert allergies/intolerances
  const allergyBatch: (typeof allergyIntolerance.$inferInsert)[] = [];
  for (const { resource, fileName } of allergies) {
    try {
      const normalizedPath = fileName.replace(/^apple_health_export\//, "");
      const sourceName = sourceNameMap.get(normalizedPath) ?? "Unknown";
      const parsed = parseFhirAllergyIntolerance(resource, sourceName);
      allergyBatch.push({
        providerId,
        externalId: parsed.externalId,
        name: parsed.name,
        type: parsed.type,
        clinicalStatus: parsed.clinicalStatus,
        verificationStatus: parsed.verificationStatus,
        rxnormCode: parsed.rxnormCode,
        onsetDate: parsed.onsetDate,
        reactions: parsed.reactions,
        sourceName: parsed.sourceName,
        raw: parsed.raw,
      });
    } catch (err) {
      errors.push({
        message: `AllergyIntolerance ${resource.id}: ${err instanceof Error ? err.message : String(err)}`,
        externalId: resource.id,
      });
    }
  }
  for (let i = 0; i < allergyBatch.length; i += 500) {
    await db
      .insert(allergyIntolerance)
      .values(allergyBatch.slice(i, i + 500))
      .onConflictDoNothing();
  }
  inserted += allergyBatch.length;

  return { inserted, skipped, errors };
}

export async function importMedicationDoseEvents(
  db: SyncDatabase,
  providerId: string,
  zipPath: string,
): Promise<{ inserted: number; skipped: number; errors: SyncError[] }> {
  const errors: SyncError[] = [];
  const scopedUserId = getTokenUserId();
  if (!scopedUserId) {
    throw new Error("apple-health medication dose import requires user context");
  }

  await db
    .delete(medicationDoseEvent)
    .where(
      and(
        eq(medicationDoseEvent.userId, scopedUserId),
        eq(medicationDoseEvent.providerId, providerId),
      ),
    );

  const doseEventFiles = await readZipEntries(
    zipPath,
    (name) => name.endsWith(".json") && name.includes("MedicationDoseEvent"),
  );

  if (doseEventFiles.length === 0) {
    return { inserted: 0, skipped: 0, errors };
  }

  const skipped = 0;
  const batch: (typeof medicationDoseEvent.$inferInsert)[] = [];

  for (const file of doseEventFiles) {
    try {
      const raw: unknown = JSON.parse(file.data.toString("utf-8"));
      const parsed = appleMedicationDoseEventSchema.parse(raw);
      const medicationName = medicationDoseEventName(parsed);

      batch.push({
        providerId,
        userId: scopedUserId,
        externalId: medicationDoseEventExternalId({
          ...parsed,
          medicationName,
          sourceFileName: file.name,
        }),
        medicationName,
        medicationConceptId: normalizeOptionalString(parsed.medicationConceptIdentifier),
        doseStatus: mapMedicationDoseStatus(parsed.logStatus),
        recordedAt: parseMedicationDoseRecordedAt(parsed.startDate),
        sourceName: normalizeOptionalString(parsed.sourceName),
        raw,
      });
    } catch (err) {
      errors.push({
        message: `MedicationDoseEvent ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const upsertMedicationDoseEvents = async (
    values: Array<typeof medicationDoseEvent.$inferInsert>,
  ) => {
    await db
      .insert(medicationDoseEvent)
      .values(values)
      .onConflictDoUpdate({
        target: [
          medicationDoseEvent.userId,
          medicationDoseEvent.providerId,
          medicationDoseEvent.externalId,
        ],
        set: {
          medicationName: sql`excluded.medication_name`,
          medicationConceptId: sql`excluded.medication_concept_id`,
          doseStatus: sql`excluded.dose_status`,
          recordedAt: sql`excluded.recorded_at`,
          sourceName: sql`excluded.source_name`,
          raw: sql`excluded.raw`,
        },
      });
  };

  for (let batchStart = 0; batchStart < batch.length; batchStart += 500) {
    const batchSlice = batch.slice(batchStart, batchStart + 500);
    if (hasDuplicateMedicationDoseConflictKeys(batchSlice)) {
      for (const row of batchSlice) {
        await upsertMedicationDoseEvents([row]);
      }
    } else {
      await upsertMedicationDoseEvents(batchSlice);
    }
  }

  return { inserted: batch.length, skipped, errors };
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
