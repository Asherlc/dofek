import { z } from "zod";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
const MAX_ACCOUNT_ERASURE_BACKUP_RETENTION_DAYS = 21;
const MAX_BACKUP_LIST_PAGES = 10_000;
const MAX_DELETE_BATCH_SIZE = 1_000;
const DATABASUS_BACKUP_KEY =
  /^Health-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.metadata)?(?:\.part\d{6}|\.parts)?$/;
const MANUAL_BACKUP_KEY =
  /^manual\/health-pre-metric-stream-drop-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump$/;

export interface BackupObjectPage {
  nextContinuationToken?: string;
  objects: readonly {
    key: string;
  }[];
}

export interface BackupMultipartUploadPage {
  nextKeyMarker?: string;
  nextUploadIdMarker?: string;
  uploads: readonly {
    key: string;
    uploadId: string;
  }[];
}

export interface DatabaseBackupStorage {
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  deleteObjects(
    keys: readonly string[],
  ): Promise<{ errors: readonly { code: string; key: string }[] }>;
  listMultipartUploads(
    keyMarker?: string,
    uploadIdMarker?: string,
  ): Promise<BackupMultipartUploadPage>;
  listPage(continuationToken?: string): Promise<BackupObjectPage>;
}

export interface DatabaseBackupSweepOptions {
  maxSweepPasses: number;
  now: Date;
  retentionDays: number;
}

export interface AccountErasureBackupRetentionOptions extends DatabaseBackupSweepOptions {
  piiScrubbedAt: Date;
  requestedAt: Date;
}

interface MultipartUpload {
  key: string;
  uploadId: string;
}

function parseUtcTimestamp(key: string, groups: readonly string[]): Date {
  const [
    year = Number.NaN,
    month = Number.NaN,
    day = Number.NaN,
    hour = Number.NaN,
    minute = Number.NaN,
    second = Number.NaN,
  ] = groups.map(Number);
  const timestamp = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    timestamp.getUTCFullYear() !== year ||
    timestamp.getUTCMonth() !== month - 1 ||
    timestamp.getUTCDate() !== day ||
    timestamp.getUTCHours() !== hour ||
    timestamp.getUTCMinutes() !== minute ||
    timestamp.getUTCSeconds() !== second
  ) {
    throw new Error(`Unknown database backup object key: ${key}`);
  }
  return timestamp;
}

function databaseBackupStartedAt(key: string): Date {
  const match = DATABASUS_BACKUP_KEY.exec(key) ?? MANUAL_BACKUP_KEY.exec(key);
  if (!match) {
    throw new Error(`Unknown database backup object key: ${key}`);
  }
  return parseUtcTimestamp(key, match.slice(1, 7));
}

async function scanDatabaseBackups(
  storage: DatabaseBackupStorage,
  cutoff: Date,
): Promise<string[]> {
  let continuationToken: string | undefined;
  const matchingKeys: string[] = [];
  const seenContinuationTokens = new Set<string>();
  let pagesInspected = 0;
  do {
    pagesInspected += 1;
    if (pagesInspected > MAX_BACKUP_LIST_PAGES) {
      throw new Error("R2 database backup listing exceeded the bounded page limit");
    }
    const page = await storage.listPage(continuationToken);
    for (const object of page.objects) {
      if (databaseBackupStartedAt(object.key) <= cutoff) {
        matchingKeys.push(object.key);
      }
    }
    continuationToken = page.nextContinuationToken;
    if (continuationToken !== undefined && continuationToken.length === 0) {
      throw new Error("R2 database backup listing was truncated without a continuation token");
    }
    if (continuationToken && seenContinuationTokens.has(continuationToken)) {
      throw new Error("R2 database backup listing repeated a continuation token");
    }
    if (continuationToken) {
      seenContinuationTokens.add(continuationToken);
    }
  } while (continuationToken);
  return matchingKeys;
}

async function scanDatabaseBackupMultipartUploads(
  storage: DatabaseBackupStorage,
  cutoff: Date,
): Promise<MultipartUpload[]> {
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  const matchingUploads: MultipartUpload[] = [];
  const seenMarkers = new Set<string>();
  let pagesInspected = 0;
  do {
    pagesInspected += 1;
    if (pagesInspected > MAX_BACKUP_LIST_PAGES) {
      throw new Error("R2 database backup multipart listing exceeded the bounded page limit");
    }
    const page = await storage.listMultipartUploads(keyMarker, uploadIdMarker);
    for (const upload of page.uploads) {
      if (databaseBackupStartedAt(upload.key) <= cutoff) {
        matchingUploads.push(upload);
      }
    }

    const hasKeyMarker = page.nextKeyMarker !== undefined;
    const hasUploadIdMarker = page.nextUploadIdMarker !== undefined;
    if (
      hasKeyMarker !== hasUploadIdMarker ||
      page.nextKeyMarker === "" ||
      page.nextUploadIdMarker === ""
    ) {
      throw new Error(
        "R2 database backup multipart listing was truncated without continuation markers",
      );
    }
    if (!hasKeyMarker || !hasUploadIdMarker) {
      return matchingUploads;
    }

    keyMarker = page.nextKeyMarker;
    uploadIdMarker = page.nextUploadIdMarker;
    const markerPair = `${keyMarker}\0${uploadIdMarker}`;
    if (seenMarkers.has(markerPair)) {
      throw new Error("R2 database backup multipart listing repeated continuation markers");
    }
    seenMarkers.add(markerPair);
  } while (keyMarker && uploadIdMarker);
  return matchingUploads;
}

function summarizeDeleteErrors(errors: readonly { code: string; key: string }[]): string {
  return [...errors]
    .sort((left, right) => left.key.localeCompare(right.key) || left.code.localeCompare(right.code))
    .map((error) => `${error.code} (${error.key})`)
    .join(", ");
}

async function deleteDatabaseBackupObjects(
  storage: DatabaseBackupStorage,
  keys: readonly string[],
): Promise<void> {
  for (let offset = 0; offset < keys.length; offset += MAX_DELETE_BATCH_SIZE) {
    const batch = keys.slice(offset, offset + MAX_DELETE_BATCH_SIZE);
    const result = await storage.deleteObjects(batch);
    if (result.errors.length > 0) {
      throw new Error(
        `R2 database backup deletion returned ${result.errors.length} object error(s): ${summarizeDeleteErrors(result.errors)}`,
      );
    }
  }
}

async function removeDatabaseBackupsAtOrBefore(
  storage: DatabaseBackupStorage,
  cutoff: Date,
  maxSweepPasses: number,
): Promise<{ deletedObjects: number }> {
  const deletedKeys = new Set<string>();

  for (let pass = 1; pass <= maxSweepPasses; pass += 1) {
    const [objects, uploads] = await Promise.all([
      scanDatabaseBackups(storage, cutoff),
      scanDatabaseBackupMultipartUploads(storage, cutoff),
    ]);

    await deleteDatabaseBackupObjects(storage, objects);
    for (const key of objects) deletedKeys.add(key);
    for (const upload of uploads) {
      await storage.abortMultipartUpload(upload.key, upload.uploadId);
    }

    const [remainingObjects, remainingUploads] = await Promise.all([
      scanDatabaseBackups(storage, cutoff),
      scanDatabaseBackupMultipartUploads(storage, cutoff),
    ]);
    if (remainingObjects.length === 0 && remainingUploads.length === 0) {
      return { deletedObjects: deletedKeys.size };
    }
    if (pass === maxSweepPasses) {
      throw new Error(
        `R2 database backup sweep left ${remainingObjects.length} expired object(s) and ${remainingUploads.length} expired multipart upload(s) after ${maxSweepPasses} pass(es)`,
      );
    }
  }

  throw new Error("R2 database backup sweep ended without verification");
}

function parseSweepOptions(options: DatabaseBackupSweepOptions): DatabaseBackupSweepOptions {
  return z
    .object({
      maxSweepPasses: z.number().int().positive().max(10),
      now: z.date(),
      retentionDays: z.number().int().positive().max(MAX_ACCOUNT_ERASURE_BACKUP_RETENTION_DAYS),
    })
    .parse(options);
}

export async function sweepExpiredDatabaseBackups(
  storage: DatabaseBackupStorage,
  options: DatabaseBackupSweepOptions,
): Promise<{ deletedObjects: number }> {
  const parsed = parseSweepOptions(options);
  const cutoff = new Date(parsed.now.getTime() - parsed.retentionDays * MILLISECONDS_PER_DAY);
  return removeDatabaseBackupsAtOrBefore(storage, cutoff, parsed.maxSweepPasses);
}

export async function verifyAccountErasureBackupRetention(
  storage: DatabaseBackupStorage,
  options: AccountErasureBackupRetentionOptions,
): Promise<{ deletedObjects: number }> {
  const parsed = z
    .object({
      maxSweepPasses: z.number().int().positive().max(10),
      now: z.date(),
      piiScrubbedAt: z.date(),
      requestedAt: z.date(),
      retentionDays: z.number().int().positive().max(MAX_ACCOUNT_ERASURE_BACKUP_RETENTION_DAYS),
    })
    .refine(
      (value) => value.piiScrubbedAt >= value.requestedAt,
      "piiScrubbedAt must not precede requestedAt",
    )
    .refine((value) => value.now >= value.piiScrubbedAt, "now must not precede piiScrubbedAt")
    .parse(options);
  const retentionCutoff = new Date(
    parsed.now.getTime() - parsed.retentionDays * MILLISECONDS_PER_DAY,
  );
  const cleanupBoundary =
    parsed.piiScrubbedAt >= retentionCutoff ? parsed.piiScrubbedAt : retentionCutoff;
  return removeDatabaseBackupsAtOrBefore(storage, cleanupBoundary, parsed.maxSweepPasses);
}
