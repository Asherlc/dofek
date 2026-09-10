import { createHash } from "node:crypto";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

const historyRowSchema = z.object({
  id: z.string().uuid(),
  evidence_kind: z.literal("configured"),
  sport: z.string(),
  threshold_type: z.string(),
  value: z.coerce.number().positive(),
  unit: z.string(),
  event_at: timestampStringSchema,
  observed_at: timestampStringSchema.nullable(),
  effective_at: timestampStringSchema.nullable(),
  provider_id: z.string().nullable(),
  provider_record_id: z.string().nullable(),
  raw_available: z.boolean(),
});

const legacyFtpSchema = z.object({ ftp: z.coerce.number().positive().nullable() });

const cursorSchema = z
  .object({
    version: z.literal(1),
    userId: z.string().uuid(),
    shape: z.string(),
    eventAt: timestampStringSchema,
    evidenceKind: z.literal("configured"),
    id: z.string().uuid(),
  })
  .strict();

type HistoryRow = z.infer<typeof historyRowSchema>;
type HistoryCursor = z.infer<typeof cursorSchema>;

export interface CyclingThresholdHistoryInput {
  startDate: string;
  endDate: string;
  cursor: string | null;
  limit: number;
}

export interface CyclingThresholdHistoryItem {
  id: string;
  evidence_kind: "configured";
  sport: string;
  threshold_type: string;
  value: number;
  unit: string;
  observed_at: string | null;
  effective_at: string | null;
  provider: string | null;
  provider_record_id: string | null;
  value_kind: "configured";
  historical_validity: "effective_dated";
  raw_evidence_available: false;
  quality: {
    status: "high" | "moderate" | "limited";
    reason: string | null;
  };
}

export interface LegacyCurrentFtp {
  value: number;
  unit: "watt";
  source: "user_profile.ftp";
  value_kind: "configured";
  historical_validity: "unknown";
  reason: string;
}

export interface CyclingThresholdHistoryPage {
  start_date: string;
  end_date: string;
  items: CyclingThresholdHistoryItem[];
  legacy_current: LegacyCurrentFtp | null;
  next_cursor: string | null;
}

function requestShape(input: CyclingThresholdHistoryInput, timezone: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        startDate: input.startDate,
        endDate: input.endDate,
        timezone,
      }),
    )
    .digest("hex");
}

function decodeCursor(cursor: string, userId: string, shape: string): HistoryCursor {
  let parsed: HistoryCursor;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("invalid encoding");
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (
      Buffer.byteLength(decoded, "utf8") > 2_048 ||
      Buffer.from(decoded, "utf8").toString("base64url") !== cursor
    ) {
      throw new Error("invalid encoding");
    }
    parsed = cursorSchema.parse(JSON.parse(decoded));
  } catch {
    throw new Error("Invalid analytical cursor");
  }
  if (parsed.userId !== userId || parsed.shape !== shape) {
    throw new Error("Cursor does not match this request");
  }
  return parsed;
}

function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursorSchema.parse(cursor)), "utf8").toString("base64url");
}

function toHistoryItem(row: HistoryRow): CyclingThresholdHistoryItem {
  return {
    id: row.id,
    evidence_kind: row.evidence_kind,
    sport: row.sport,
    threshold_type: row.threshold_type,
    value: row.value,
    unit: row.unit,
    observed_at: row.observed_at,
    effective_at: row.effective_at,
    provider: null,
    provider_record_id: null,
    value_kind: "configured",
    historical_validity: "effective_dated",
    raw_evidence_available: false,
    quality: { status: "high", reason: null },
  };
}

/** Effective-dated user threshold configuration. */
export class CyclingThresholdRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(db: Pick<Database, "execute">, userId: string, timezone: string) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  /** Latest effective-dated cycling FTP configuration on or before a date. */
  async getApplicableConfiguredFtp(asOfDate: string): Promise<CyclingThresholdHistoryItem | null> {
    const rows = await executeWithSchema(
      this.#db,
      historyRowSchema,
      sql`
        SELECT
          settings.id,
          'configured'::text AS evidence_kind,
          settings.sport,
          'ftp'::text AS threshold_type,
          settings.ftp::real AS value,
          'watt'::text AS unit,
          settings.effective_from::timestamp AT TIME ZONE ${this.#timezone} AS event_at,
          settings.created_at AS observed_at,
          settings.effective_from::timestamp AT TIME ZONE ${this.#timezone} AS effective_at,
          NULL::text AS provider_id,
          NULL::text AS provider_record_id,
          false AS raw_available
        FROM fitness.sport_settings AS settings
        WHERE settings.user_id = ${this.#userId}::uuid
          AND settings.sport = 'cycling'
          AND settings.ftp IS NOT NULL
          AND settings.effective_from <= ${asOfDate}::date
        ORDER BY settings.effective_from DESC, settings.created_at DESC, settings.id ASC
        LIMIT 1
      `,
    );
    return rows[0] ? toHistoryItem(rows[0]) : null;
  }

  async listHistory(input: CyclingThresholdHistoryInput): Promise<CyclingThresholdHistoryPage> {
    const shape = requestShape(input, this.#timezone);
    const cursor = input.cursor ? decodeCursor(input.cursor, this.#userId, shape) : null;
    const cursorFilter = cursor
      ? sql`WHERE (
          history.event_at < ${cursor.eventAt}
          OR (
            history.event_at = ${cursor.eventAt}
            AND history.evidence_kind > ${cursor.evidenceKind}
          )
          OR (
            history.event_at = ${cursor.eventAt}
            AND history.evidence_kind = ${cursor.evidenceKind}
            AND history.id > ${cursor.id}::uuid
          )
        )`
      : sql``;

    const rows = await executeWithSchema(
      this.#db,
      historyRowSchema,
      sql`
        WITH history AS (
          SELECT
            settings.id,
            'configured'::text AS evidence_kind,
            settings.sport,
            'ftp'::text AS threshold_type,
            settings.ftp::real AS value,
            'watt'::text AS unit,
            settings.effective_from::timestamp AT TIME ZONE ${this.#timezone} AS event_at,
            settings.created_at AS observed_at,
            settings.effective_from::timestamp AT TIME ZONE ${this.#timezone} AS effective_at,
            NULL::text AS provider_id,
            NULL::text AS provider_record_id,
            false AS raw_available
          FROM fitness.sport_settings AS settings
          WHERE settings.user_id = ${this.#userId}::uuid
            AND settings.sport = 'cycling'
            AND settings.ftp IS NOT NULL
            AND settings.effective_from BETWEEN ${input.startDate}::date AND ${input.endDate}::date
        )
        SELECT *
        FROM history
        ${cursorFilter}
        ORDER BY event_at DESC, evidence_kind ASC, id ASC
        LIMIT ${input.limit + 1}
      `,
    );

    const hasNextPage = rows.length > input.limit;
    const pageRows = rows.slice(0, input.limit);
    const last = pageRows.at(-1);
    const nextCursor =
      hasNextPage && last
        ? encodeCursor({
            version: 1,
            userId: this.#userId,
            shape,
            eventAt: last.event_at,
            evidenceKind: last.evidence_kind,
            id: last.id,
          })
        : null;

    let legacyCurrent: LegacyCurrentFtp | null = null;
    const legacyRows = await executeWithSchema(
      this.#db,
      legacyFtpSchema,
      sql`SELECT ftp FROM fitness.user_profile WHERE id = ${this.#userId}::uuid`,
    );
    const ftp = legacyRows[0]?.ftp ?? null;
    if (ftp !== null) {
      legacyCurrent = {
        value: ftp,
        unit: "watt",
        source: "user_profile.ftp",
        value_kind: "configured",
        historical_validity: "unknown",
        reason:
          "Legacy current FTP has no effective date and is not applied to historical activities",
      };
    }

    return {
      start_date: input.startDate,
      end_date: input.endDate,
      items: pageRows.map(toHistoryItem),
      legacy_current: legacyCurrent,
      next_cursor: nextCursor,
    };
  }
}
