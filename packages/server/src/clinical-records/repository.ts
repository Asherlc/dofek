import type { Database } from "dofek/db";
import { clinicalRecord } from "dofek/db/schema/clinical";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  type ClinicalRecordDetail,
  type ClinicalRecordInput,
  type ClinicalRecordSummary,
  deriveClinicalRecordDates,
  fhirObjectSchema,
  summarizeClinicalRecord,
} from "./fhir.ts";

const PROVIDER_ID = "apple_health";

export interface ClinicalRecordPageInput {
  limit: number;
  offset: number;
}

export interface ClinicalRecordPage {
  records: ClinicalRecordSummary[];
  nextOffset: number | null;
}

export interface ClinicalRecordUpsertResult {
  inserted: number;
  ids: string[];
}

const summaryColumns = {
  id: clinicalRecord.id,
  clinicalType: clinicalRecord.clinicalType,
  displayName: clinicalRecord.displayName,
  sourceName: clinicalRecord.sourceName,
  downloadedAt: clinicalRecord.downloadedAt,
  recordedAt: clinicalRecord.recordedAt,
  issuedAt: clinicalRecord.issuedAt,
};

export class ClinicalRecordsRepository {
  readonly #db: Database;
  readonly #timeZone: string;
  readonly #userId: string;

  constructor(database: Database, userId: string, timeZone: string) {
    this.#db = database;
    this.#userId = userId;
    this.#timeZone = timeZone;
  }

  async upsert(records: ClinicalRecordInput[]): Promise<ClinicalRecordUpsertResult> {
    if (records.length === 0) return { inserted: 0, ids: [] };

    const rowsByExternalId = new Map<string, typeof clinicalRecord.$inferInsert>();
    for (const record of records) {
      const dates = deriveClinicalRecordDates(record.clinicalType, record.fhirVersion, record.fhir);
      rowsByExternalId.set(record.externalId, {
        userId: this.#userId,
        providerId: PROVIDER_ID,
        externalId: record.externalId,
        clinicalType: record.clinicalType,
        displayName: record.displayName,
        sourceName: record.sourceName,
        fhirVersion: record.fhirVersion,
        fhir: record.fhir,
        downloadedAt: new Date(record.downloadedAt),
        recordedAt: dates.recordedAt,
        issuedAt: dates.issuedAt,
      });
    }
    const rows = [...rowsByExternalId.values()];

    const persisted = await this.#db
      .insert(clinicalRecord)
      .values(rows)
      .onConflictDoUpdate({
        target: [clinicalRecord.userId, clinicalRecord.providerId, clinicalRecord.externalId],
        set: {
          clinicalType: sql`excluded.clinical_type`,
          displayName: sql`excluded.display_name`,
          sourceName: sql`excluded.source_name`,
          fhirVersion: sql`excluded.fhir_version`,
          fhir: sql`excluded.fhir`,
          downloadedAt: sql`excluded.downloaded_at`,
          recordedAt: sql`excluded.recorded_at`,
          issuedAt: sql`excluded.issued_at`,
        },
      })
      .returning({ id: clinicalRecord.id });

    return { inserted: persisted.length, ids: persisted.map((row) => row.id) };
  }

  async list(input: ClinicalRecordPageInput): Promise<ClinicalRecordPage> {
    const rows = await this.#db
      .select(summaryColumns)
      .from(clinicalRecord)
      .where(eq(clinicalRecord.userId, this.#userId))
      .orderBy(desc(clinicalRecord.downloadedAt), desc(clinicalRecord.id))
      .limit(input.limit + 1)
      .offset(input.offset);
    const hasNextPage = rows.length > input.limit;

    return {
      records: rows
        .slice(0, input.limit)
        .map((row) => summarizeClinicalRecord(row, this.#timeZone)),
      nextOffset: hasNextPage ? input.offset + input.limit : null,
    };
  }

  async detail(id: string): Promise<ClinicalRecordDetail | null> {
    const [row] = await this.#db
      .select({
        ...summaryColumns,
        providerId: clinicalRecord.providerId,
        externalId: clinicalRecord.externalId,
        fhirVersion: clinicalRecord.fhirVersion,
        fhir: clinicalRecord.fhir,
      })
      .from(clinicalRecord)
      .where(and(eq(clinicalRecord.id, id), eq(clinicalRecord.userId, this.#userId)))
      .limit(1);

    if (!row) return null;
    return {
      ...summarizeClinicalRecord(row, this.#timeZone),
      providerId: row.providerId,
      externalId: row.externalId,
      fhirVersion: row.fhirVersion,
      fhir: fhirObjectSchema.parse(row.fhir),
    };
  }
}
