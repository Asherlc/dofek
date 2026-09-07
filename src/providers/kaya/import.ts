import { createHash } from "node:crypto";
import { resolveProviderActivityType } from "@dofek/training/activity-types";
import { parseClimbingGrade } from "@dofek/training/climbing-grades";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { SyncDatabase } from "../../db/index.ts";
import { upsertProviderActivity } from "../../db/provider-activity-sync.ts";
import { climbingEntry } from "../../db/schema/activity.ts";
import { ensureProvider } from "../../db/tokens.ts";
import type { SyncError, SyncResult } from "../types.ts";
import { KAYA_PROVIDER_ID, KAYA_PROVIDER_NAME } from "./provider.ts";

const KAYA_HEADER = [
  "date",
  "stiffness",
  "rating",
  "ascent_type",
  "attempts",
  "grade",
  "color",
  "climb_name",
  "gym",
  "location",
  "country",
] as const;

const SENT_ASCENT_TYPES = new Set(["Flash", "Onsight", "Redpoint", "Repeat"]);
const attemptCountSchema = z.number().int().min(1).max(2_147_483_647);

interface KayaDecodedRow {
  date: string;
  stiffness: string;
  rating: string;
  ascent_type: string;
  attempts: string;
  grade: string;
  color: string;
  climb_name: string;
  gym: string;
  location: string;
  country: string;
}

const kayaDecodedRowSchema = z.object({
  date: z.string(),
  stiffness: z.string(),
  rating: z.string(),
  ascent_type: z.string(),
  attempts: z.string(),
  grade: z.string(),
  color: z.string(),
  climb_name: z.string(),
  gym: z.string(),
  location: z.string(),
  country: z.string(),
});

export interface KayaParseError {
  rowNumber: number | null;
  message: string;
}

export interface KayaRawEntry {
  date: string;
  stiffness: number | null;
  rating: number | null;
  ascentType: string;
  attempts: number | null;
  grade: string;
  color: string | null;
  climbName: string | null;
  gym: string;
  location: string | null;
  country: string | null;
}

export interface KayaClimbingEntry {
  externalId: string;
  climbType: "boulder" | "route";
  gradeSystem: "v_scale" | "yds";
  grade: string;
  sent: boolean;
  attemptCount: number;
  lead: null;
  routeName: string | null;
  locationName: string | null;
  sourceName: "Kaya";
  raw: KayaRawEntry;
}

export interface KayaClimbingActivity {
  externalId: string;
  name: string;
  activityType: "rock_climbing";
  locationName: string;
  startedAt: Date;
  endedAt: Date;
  entries: KayaClimbingEntry[];
}

export interface KayaParseResult {
  activities: KayaClimbingActivity[];
  errors: KayaParseError[];
}

interface ParsedKayaRow {
  rowNumber: number;
  date: Date;
  gym: string;
  entry: KayaClimbingEntry;
}

export interface KayaImportDatabase extends SyncDatabase {
  transaction: <TResult>(
    callback: (transactionDb: SyncDatabase) => Promise<TResult>,
  ) => Promise<TResult>;
}

export async function importKayaExportFile(
  db: KayaImportDatabase,
  csvText: string,
  userId: string,
): Promise<SyncResult> {
  return new KayaExportImporter(db, userId).import(csvText);
}

class KayaExportImporter {
  readonly #db: KayaImportDatabase;
  readonly #userId: string;

  constructor(db: KayaImportDatabase, userId: string) {
    this.#db = db;
    this.#userId = userId;
  }

  async import(csvText: string): Promise<SyncResult> {
    const startedAt = Date.now();
    const parsed = parseKayaExport(csvText);
    const recordsSynced = await this.#db.transaction(async (transactionDb) => {
      await ensureProvider(
        transactionDb,
        KAYA_PROVIDER_ID,
        KAYA_PROVIDER_NAME,
        undefined,
        this.#userId,
      );

      let syncedRecords = 0;
      for (const activity of parsed.activities) {
        syncedRecords += await this.#upsertActivity(transactionDb, activity);
      }
      return syncedRecords;
    });

    return {
      provider: KAYA_PROVIDER_ID,
      recordsSynced,
      errors: parsed.errors.map((error) => this.#toSyncError(error)),
      duration: Date.now() - startedAt,
    };
  }

  async #upsertActivity(db: SyncDatabase, kayaActivity: KayaClimbingActivity): Promise<number> {
    const row = await upsertProviderActivity(
      db,
      {
        providerId: KAYA_PROVIDER_ID,
        userId: this.#userId,
        externalId: kayaActivity.externalId,
        activityType: resolveProviderActivityType(
          kayaActivity.activityType,
          kayaActivity.activityType,
        ),
        startedAt: kayaActivity.startedAt,
        endedAt: kayaActivity.endedAt,
        name: kayaActivity.name,
        sourceName: KAYA_PROVIDER_NAME,
        raw: {
          locationName: kayaActivity.locationName,
          source: KAYA_PROVIDER_ID,
        },
      },
      {
        activityType: resolveProviderActivityType(
          kayaActivity.activityType,
          kayaActivity.activityType,
        ),
        startedAt: kayaActivity.startedAt,
        endedAt: kayaActivity.endedAt,
        name: kayaActivity.name,
        sourceName: KAYA_PROVIDER_NAME,
        raw: {
          locationName: kayaActivity.locationName,
          source: KAYA_PROVIDER_ID,
        },
      },
    );
    if (!row) return 0;

    await db.delete(climbingEntry).where(eq(climbingEntry.activityId, row.id));
    if (kayaActivity.entries.length === 0) return 0;

    await db.insert(climbingEntry).values(
      kayaActivity.entries.map((entry) => ({
        activityId: row.id,
        externalId: entry.externalId,
        climbType: entry.climbType,
        gradeSystem: entry.gradeSystem,
        grade: entry.grade,
        sent: entry.sent,
        attemptCount: entry.attemptCount,
        lead: entry.lead,
        routeName: entry.routeName,
        locationName: entry.locationName,
        sourceName: entry.sourceName,
        raw: entry.raw,
      })),
    );

    return kayaActivity.entries.length;
  }

  #toSyncError(error: KayaParseError): SyncError {
    return {
      message: error.message,
      externalId: error.rowNumber === null ? undefined : `row-${error.rowNumber}`,
    };
  }
}

export function parseKayaExport(csvText: string): KayaParseResult {
  return new KayaExportParser(csvText).parse();
}

class KayaExportParser {
  readonly #csvText: string;

  constructor(csvText: string) {
    this.#csvText = csvText;
  }

  parse(): KayaParseResult {
    const decodedCsv = decodeCsv(this.#csvText);
    if (!decodedCsv.ok) {
      return {
        activities: [],
        errors: [{ rowNumber: decodedCsv.rowNumber, message: decodedCsv.message }],
      };
    }

    const [header, ...dataRows] = decodedCsv.rows;
    if (!header || header.fields.join(",") !== KAYA_HEADER.join(",")) {
      return {
        activities: [],
        errors: [{ rowNumber: null, message: "header does not match Kaya export format" }],
      };
    }

    const errors: KayaParseError[] = [];
    const parsedRows: ParsedKayaRow[] = [];

    dataRows.forEach(({ fields, rowNumber }) => {
      if (fields.length !== KAYA_HEADER.length) {
        errors.push({ rowNumber, message: `row ${rowNumber}: malformed CSV row` });
        return;
      }

      const rowObject = Object.fromEntries(
        KAYA_HEADER.map((fieldName, fieldIndex) => [fieldName, fields[fieldIndex] ?? ""]),
      );
      const parseResult = kayaDecodedRowSchema.safeParse(rowObject);
      if (!parseResult.success) {
        errors.push({ rowNumber, message: `row ${rowNumber}: malformed CSV row` });
        return;
      }

      const parsedRow = this.#parseRow(parseResult.data, rowNumber);
      if ("message" in parsedRow) {
        errors.push(parsedRow);
        return;
      }

      parsedRows.push(parsedRow);
    });

    return {
      activities: this.#buildActivities(parsedRows),
      errors,
    };
  }

  #parseRow(row: KayaDecodedRow, rowNumber: number): ParsedKayaRow | KayaParseError {
    const dateText = row.date.trim();
    if (dateText === "") {
      return { rowNumber, message: `row ${rowNumber}: date is required` };
    }

    const date = new Date(dateText);
    if (Number.isNaN(date.getTime())) {
      return { rowNumber, message: `row ${rowNumber}: date is not a valid Kaya date` };
    }

    const gym = nullableText(row.gym);
    if (gym === null) {
      return { rowNumber, message: `row ${rowNumber}: gym is required` };
    }

    const parsedGrade = parseClimbingGrade(row.grade);
    if (!parsedGrade) {
      return { rowNumber, message: `row ${rowNumber}: grade is unsupported` };
    }

    if (!SENT_ASCENT_TYPES.has(row.ascent_type)) {
      return { rowNumber, message: `row ${rowNumber}: ascent_type is unsupported` };
    }

    const raw: KayaRawEntry = {
      date: row.date,
      stiffness: nullableNumber(row.stiffness),
      rating: nullableNumber(row.rating),
      ascentType: row.ascent_type,
      attempts: nullableNumber(row.attempts),
      grade: row.grade,
      color: nullableText(row.color),
      climbName: nullableText(row.climb_name),
      gym,
      location: nullableText(row.location),
      country: nullableText(row.country),
    };
    const attemptCount = raw.attempts ?? 1;
    if (!attemptCountSchema.safeParse(attemptCount).success) {
      return { rowNumber, message: `row ${rowNumber}: attempts must be a positive integer` };
    }
    const routeName = nullableText(row.climb_name);
    const entryHash = stableHash([
      row.date,
      gym,
      routeName ?? "",
      parsedGrade.grade,
      nullableText(row.color) ?? "",
      row.ascent_type,
      String(rowNumber),
    ]);

    return {
      rowNumber,
      date,
      gym,
      entry: {
        externalId: `kaya:entry:${entryHash}`,
        climbType: parsedGrade.gradeSystem === "v_scale" ? "boulder" : "route",
        gradeSystem: parsedGrade.gradeSystem,
        grade: parsedGrade.grade,
        sent: true,
        attemptCount,
        lead: null,
        routeName,
        locationName: gym,
        sourceName: KAYA_PROVIDER_NAME,
        raw,
      },
    };
  }

  #buildActivities(rows: ParsedKayaRow[]): KayaClimbingActivity[] {
    const activityMap = new Map<string, KayaClimbingActivity>();

    for (const row of rows) {
      const sessionDate = row.date.toISOString().slice(0, 10);
      const sessionKey = `${row.gym}|${sessionDate}`;
      const existingActivity = activityMap.get(sessionKey);
      if (existingActivity) {
        existingActivity.entries.push(row.entry);
        if (row.date < existingActivity.startedAt) {
          existingActivity.startedAt = row.date;
        }
        if (row.date > existingActivity.endedAt) {
          existingActivity.endedAt = row.date;
        }
        continue;
      }

      activityMap.set(sessionKey, {
        externalId: `kaya:session:${stableHash([row.gym, sessionDate])}`,
        name: `Kaya climbing at ${row.gym}`,
        activityType: "rock_climbing",
        locationName: row.gym,
        startedAt: row.date,
        endedAt: row.date,
        entries: [row.entry],
      });
    }

    return Array.from(activityMap.values());
  }
}

function nullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function nullableNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const numberValue = Number(trimmed);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function stableHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 16);
}

type DecodeCsvResult =
  | { ok: true; rows: Array<{ fields: string[]; rowNumber: number }> }
  | { ok: false; rowNumber: number | null; message: string };

function decodeCsv(csvText: string): DecodeCsvResult {
  const text = csvText.replace(/^\uFEFF/, "");
  const rows: Array<{ fields: string[]; rowNumber: number }> = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let rowNumber = 1;

  for (let index = 0; index < text.length; index++) {
    const character = text[index];

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      inQuotes = true;
      continue;
    }

    if (character === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (character === "\n") {
      row.push(field);
      rows.push({ fields: row, rowNumber });
      row = [];
      field = "";
      rowNumber++;
      continue;
    }

    if (character === "\r") {
      continue;
    }

    field += character;
  }

  if (inQuotes) {
    return { ok: false, rowNumber, message: `row ${rowNumber}: malformed CSV row` };
  }

  row.push(field);
  rows.push({ fields: row, rowNumber });

  return {
    ok: true,
    rows: rows.filter((row) => row.fields.some((value) => value.trim() !== "")),
  };
}
