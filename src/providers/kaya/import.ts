import { createHash } from "node:crypto";
import { resolveProviderActivityType } from "@dofek/training/activity-types";
import { parseClimbingGrade } from "@dofek/training/climbing-grades";
import { z } from "zod";
import {
  type ClimbingLogSessionsSyncInput,
  persistClimbingLogSessions,
} from "../../db/climbing-log-session-sync.ts";
import type { SourceClimbingAttempt, SourceClimbingLogEntry } from "../../db/climbing-log-sync.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { upsertProviderActivity } from "../../db/provider-activity-sync.ts";
import { ensureProvider } from "../../db/tokens.ts";
import { decodeCsv } from "../../lib/csv.ts";
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
  gym: string | null;
  location: string | null;
  country: string | null;
}

export interface KayaExportSession {
  externalId: string;
  name: string;
  activityType: "rock_climbing";
  locationName: string;
  startedAt: Date;
  endedAt: Date;
  entries: SourceClimbingLogEntry[];
}

export interface KayaParseResult {
  sessions: KayaExportSession[];
  standaloneEntries: SourceClimbingLogEntry[];
  errors: KayaParseError[];
}

interface ParsedKayaRow {
  rowNumber: number;
  date: Date | null;
  gym: string | null;
  entry: SourceClimbingLogEntry;
}

export async function importKayaExportFile(
  db: SyncDatabase,
  csvText: string,
  userId: string,
): Promise<SyncResult> {
  return new KayaExportImporter(db, userId).import(csvText);
}

class KayaExportImporter {
  readonly #db: SyncDatabase;
  readonly #userId: string;

  constructor(db: SyncDatabase, userId: string) {
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

      const sessions: ClimbingLogSessionsSyncInput["sessions"][number][] = [];
      for (const activity of parsed.sessions) {
        const session = await this.#upsertActivity(
          transactionDb,
          activity,
          parsed.errors.length === 0,
        );
        if (session) sessions.push(session);
      }
      const result = await persistClimbingLogSessions(transactionDb, {
        userId: this.#userId,
        providerId: KAYA_PROVIDER_ID,
        standaloneEntries: parsed.standaloneEntries,
        sessions,
      });
      return result.recordsSynced;
    });

    return {
      provider: KAYA_PROVIDER_ID,
      recordsSynced,
      errors: parsed.errors.map((error) => this.#toSyncError(error)),
      duration: Date.now() - startedAt,
    };
  }

  async #upsertActivity(
    db: SyncDatabase,
    kayaActivity: KayaExportSession,
    complete: boolean,
  ): Promise<ClimbingLogSessionsSyncInput["sessions"][number] | undefined> {
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
    if (!row) return undefined;
    return {
      activityId: row.id,
      entries: kayaActivity.entries,
      complete,
    };
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
        sessions: [],
        standaloneEntries: [],
        errors: [{ rowNumber: decodedCsv.rowNumber, message: decodedCsv.message }],
      };
    }

    const [header, ...dataRows] = decodedCsv.rows;
    if (!header || header.fields.join(",") !== KAYA_HEADER.join(",")) {
      return {
        sessions: [],
        standaloneEntries: [],
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
      sessions: this.#buildSessions(parsedRows),
      standaloneEntries: parsedRows
        .filter((row) => row.date === null || row.gym === null)
        .map((row) => row.entry),
      errors,
    };
  }

  #parseRow(row: KayaDecodedRow, rowNumber: number): ParsedKayaRow | KayaParseError {
    const dateText = row.date.trim();
    const date = dateText === "" ? null : new Date(dateText);
    if (
      date !== null &&
      (Number.isNaN(date.getTime()) ||
        date.getUTCFullYear() < 1 ||
        date.getUTCFullYear() > 9999 ||
        (/^\d{4}-\d{2}-\d{2}/.test(dateText) &&
          !z.iso.date().safeParse(dateText.slice(0, 10)).success))
    ) {
      return { rowNumber, message: `row ${rowNumber}: date is not a valid Kaya date` };
    }

    const gym = nullableText(row.gym);
    const parsedGrade = parseClimbingGrade(row.grade);

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
    const attemptCount = raw.attempts;
    if (attemptCount !== null && !attemptCountSchema.safeParse(attemptCount).success) {
      return { rowNumber, message: `row ${rowNumber}: attempts must be a positive integer` };
    }
    const routeName = nullableText(row.climb_name);
    const entryHash = stableHash([
      row.date,
      gym ?? "",
      routeName ?? "",
      parsedGrade?.grade ?? row.grade.trim(),
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
        climbedOn: date?.toISOString().slice(0, 10) ?? null,
        discipline: parsedGrade ? "rock_climbing" : null,
        reportedGrades: parsedGrade
          ? [{ value: parsedGrade.grade, system: parsedGrade.gradeSystem }]
          : row.grade.trim()
            ? [{ value: row.grade.trim(), system: null }]
            : [],
        ...(attemptCount === null
          ? {}
          : { reportedAttemptCounts: [{ scope: "climb", count: attemptCount }] }),
        attempts: [csvAttempt(raw.ascentType)],
        climb: {
          externalId: null,
          name: routeName,
          kind: parsedGrade ? (parsedGrade.gradeSystem === "v_scale" ? "boulder" : "route") : null,
          setting: gym ? "indoor" : null,
          ...(gym ? { areas: [{ name: gym, externalId: null }] } : {}),
        },
        sourceName: KAYA_PROVIDER_NAME,
        raw: { ...raw },
      },
    };
  }

  #buildSessions(rows: ParsedKayaRow[]): KayaExportSession[] {
    const activityMap = new Map<string, KayaExportSession>();

    for (const row of rows) {
      if (row.date === null || row.gym === null) continue;
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

function csvAttempt(value: string): SourceClimbingAttempt {
  const label = value.trim().toLowerCase();
  const qualifier: SourceClimbingAttempt["qualifier"] =
    label === "onsight"
      ? "free-onsight"
      : label === "flash"
        ? "free-flash"
        : ["redpoint", "send", "repeat"].includes(label)
          ? "free-send"
          : undefined;
  return {
    scope: "climb",
    ...(qualifier ? { qualifier, sourceResult: value } : {}),
    ...(label === "repeat" ? { hadCompletedBefore: true } : {}),
  };
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
