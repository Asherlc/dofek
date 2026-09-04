import { randomUUID } from "node:crypto";
import type { Database } from "dofek/db";
import {
  createProviderDataDeletionRequest,
  findProviderDataDeletionRequest,
  type ProviderDataDeletionRequest,
  type ProviderDataDeletionRequestStatus,
} from "dofek/db/provider-data-deletion";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import {
  assertSqlColumnName,
  buildClickHouseFilterClauses,
  buildPostgresFilterConditions,
} from "../lib/field-filters.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import type { BodyClickHouseStore } from "./body-clickhouse.ts";

// ---------------------------------------------------------------------------
// Data type mapping
// ---------------------------------------------------------------------------

export const dataTypeEnum = z.enum([
  "activities",
  "dailyMetrics",
  "sleepSessions",
  "bodyMeasurements",
  "foodEntries",
  "healthEvents",
  "metricStream",
  "nutritionDaily",
  "clinicalRecords",
  "journalEntries",
]);

export type DataType = z.infer<typeof dataTypeEnum>;

interface ProviderDataDeletionTransaction {
  execute(query: SQL): Promise<unknown>;
}

/** Map data type enum to SQL table name and ordering column */
export function tableInfo(dataType: DataType): {
  table: string;
  orderColumn: string;
  idColumn: string;
} {
  switch (dataType) {
    case "activities":
      return { table: "fitness.activity", orderColumn: "started_at", idColumn: "id" };
    case "dailyMetrics":
      return { table: "fitness.daily_metrics", orderColumn: "date", idColumn: "date" };
    case "sleepSessions":
      return { table: "fitness.sleep_session", orderColumn: "started_at", idColumn: "id" };
    case "bodyMeasurements":
      return { table: "analytics.v_body_measurement", orderColumn: "recorded_at", idColumn: "id" };
    case "foodEntries":
      return { table: "fitness.food_entry", orderColumn: "date", idColumn: "id" };
    case "healthEvents":
      return { table: "fitness.health_event", orderColumn: "start_date", idColumn: "id" };
    case "metricStream":
      return {
        table: "ingest.metric_stream",
        orderColumn: "recorded_at",
        idColumn: "id",
      };
    case "nutritionDaily":
      return {
        table: "fitness.v_nutrition_provider_daily",
        orderColumn: "date",
        idColumn: "date",
      };
    case "clinicalRecords":
      return { table: "fitness.clinical_record", orderColumn: "downloaded_at", idColumn: "id" };
    case "journalEntries":
      return { table: "fitness.journal_entry", orderColumn: "date", idColumn: "id" };
  }
}

const BODY_MEASUREMENT_COLUMNS = [
  "id",
  "provider_id",
  "user_id",
  "external_id",
  "recorded_at",
  "created_at",
  "weight_kg",
  "body_fat_pct",
  "muscle_mass_kg",
  "bone_mass_kg",
  "water_pct",
  "bmi",
  "height_cm",
  "waist_circumference_cm",
  "systolic_bp",
  "diastolic_bp",
  "heart_pulse",
  "temperature_c",
  "source_name",
  "source_providers",
] as const;

const METRIC_STREAM_COLUMNS = [
  "id",
  "recorded_at",
  "provider_id",
  "external_id",
  "device_id",
  "source_type",
  "channel",
  "activity_id",
  "scalar",
] as const;

function listColumnNames(
  dataType: Exclude<DataType, "bodyMeasurements" | "metricStream">,
): string[] {
  switch (dataType) {
    case "activities":
      return [
        "id",
        "provider_id",
        "external_id",
        "canonical_type",
        "provider_type",
        "modality",
        "started_at",
        "ended_at",
        "name",
        "source_name",
        "provider_absent_at",
        "deleted_at",
        "created_at",
      ];
    case "dailyMetrics":
      return [
        "id",
        "provider_id",
        "date",
        "hrv",
        "respiratory_rate_avg",
        "steps",
        "distance_km",
        "source_name",
        "created_at",
      ];
    case "sleepSessions":
      return [
        "id",
        "provider_id",
        "external_id",
        "started_at",
        "ended_at",
        "duration_minutes",
        "sleep_type",
        "source_name",
        "created_at",
      ];
    case "foodEntries":
      return [
        "id",
        "provider_id",
        "external_id",
        "date",
        "meal",
        "food_name",
        "logged_at",
        "source_name",
        "created_at",
      ];
    case "healthEvents":
      return [
        "id",
        "provider_id",
        "external_id",
        "type",
        "value",
        "value_text",
        "unit",
        "source_name",
        "start_date",
        "end_date",
        "created_at",
      ];
    case "nutritionDaily":
      return [
        "date",
        "provider_id",
        "calories",
        "protein_g",
        "carbs_g",
        "fat_g",
        "fiber_g",
        "sugar_g",
      ];
    case "clinicalRecords":
      return [
        "id",
        "provider_id",
        "external_id",
        "clinical_type",
        "display_name",
        "source_name",
        "fhir_version",
        "downloaded_at",
        "recorded_at",
        "issued_at",
      ];
    case "journalEntries":
      return [
        "id",
        "provider_id",
        "date",
        "question_slug",
        "answer_text",
        "answer_numeric",
        "impact_score",
        "created_at",
      ];
  }
}

function listColumns(dataType: Exclude<DataType, "bodyMeasurements" | "metricStream">): string {
  return listColumnNames(dataType).join(", ");
}

const RECORD_DISPLAY_EXCLUDED = new Set(["user_id", "provider_id"]);
const RECORD_DISPLAY_PRIORITY = [
  "id",
  "name",
  "date",
  "started_at",
  "recorded_at",
  "canonical_type",
  "type",
] as const;
const RECORD_DISPLAY_PRIORITY_SET = new Set<string>(RECORD_DISPLAY_PRIORITY);
const MAX_RECORD_DISPLAY_COLUMNS = 6;

/** Columns available for server-side filtering on provider detail records. */
export function getRecordFilterColumns(dataType: DataType): readonly string[] {
  switch (dataType) {
    case "bodyMeasurements":
      return BODY_MEASUREMENT_COLUMNS;
    case "metricStream":
      return METRIC_STREAM_COLUMNS;
    default:
      return listColumnNames(dataType);
  }
}

export type ProviderDetailFilterOption = { value: string; label?: string };

const MAX_DISTINCT_FILTER_OPTIONS = 500;

/** Sync history columns exposed as dropdown filters (API keys). */
export const SYNC_LOG_FILTER_OPTION_FIELDS = {
  status: "status",
  dataType: "data_type",
  authFailureReason: "auth_failure_reason",
} as const;

/** Record columns exposed as dropdown filters, keyed by data type. */
export function getRecordSelectFilterColumns(dataType: DataType): readonly string[] {
  switch (dataType) {
    case "activities":
      return ["canonical_type", "provider_type", "modality", "source_name"];
    case "dailyMetrics":
      return ["source_name"];
    case "sleepSessions":
      return ["sleep_type", "source_name"];
    case "foodEntries":
      return ["meal", "source_name"];
    case "healthEvents":
      return ["type", "source_name"];
    case "clinicalRecords":
      return ["clinical_type", "source_name", "fhir_version"];
    case "journalEntries":
      return ["question_slug"];
    case "bodyMeasurements":
      return ["source_name"];
    case "metricStream":
      return ["source_type", "channel", "device_id"];
    case "nutritionDaily":
      return [];
  }
}

/** Whether record filter options for a column come from the journal question join. */
export function isJournalQuestionSlugFilterColumn(dataType: DataType, column: string): boolean {
  return dataType === "journalEntries" && column === "question_slug";
}

/** Whether record filter options are loaded from ClickHouse instead of Postgres. */
export function usesClickHouseRecordFilterOptions(dataType: DataType): boolean {
  return dataType === "bodyMeasurements" || dataType === "metricStream";
}

/** Curated columns shown in the provider detail records table. */
export function getRecordDisplayColumns(dataType: DataType): readonly string[] {
  const candidates = getRecordFilterColumns(dataType).filter(
    (column) => !RECORD_DISPLAY_EXCLUDED.has(column),
  );
  const prioritized = [
    ...RECORD_DISPLAY_PRIORITY.filter((column) => candidates.includes(column)),
    ...candidates.filter((column) => !RECORD_DISPLAY_PRIORITY_SET.has(column)),
  ];
  return prioritized.slice(0, MAX_RECORD_DISPLAY_COLUMNS);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Provider-owned record tables, in foreign-key-safe deletion order. */
export const PROVIDER_DATA_TABLES = [
  "fitness.daily_metrics",
  "fitness.sleep_session",
  "fitness.food_entry",
  "fitness.clinical_record",
  "fitness.supplement_dose_event",
  "fitness.medication_dose_event",
  "fitness.health_event",
  "fitness.journal_entry",
  "fitness.dexa_scan",
  "fitness.imu_session",
  "fitness.sync_log",
  "fitness.activity",
];

/** All provider-scoped tables removed when deleting an account. */
export const PROVIDER_ACCOUNT_TABLES = [
  ...PROVIDER_DATA_TABLES,
  "fitness.oauth_token",
  "fitness.provider_connection",
];

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const ownerCheckSchema = z.object({ id: z.string() });
const retainedPostgresDataSchema = z.object({ has_data: z.boolean() });
const retainedMetricStreamDataSchema = z.object({
  has_data: z.coerce.number().int().min(0).max(1),
});
const genericRowSchema = z.record(z.string(), z.unknown());
const availableDataTypeRowSchema = z.object({ data_type: dataTypeEnum });
const distinctValueSchema = z.object({ value: z.coerce.string() });
const distinctLabeledValueSchema = z.object({
  value: z.string(),
  label: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for provider detail pages: logs, records, and disconnect. */
export class ProviderDetailRepository {
  readonly #db: Pick<Database, "execute" | "transaction">;
  readonly #userId: string;
  // ClickHouse query runner. Serves the read-models that have moved off
  // Postgres: body measurements (analytics.v_body_measurement) and the
  // Redpanda-fed metric stream (ingest.metric_stream).
  readonly #clickHouse: BodyClickHouseStore | undefined;

  constructor(
    db: Pick<Database, "execute" | "transaction">,
    userId: string,
    clickHouse?: BodyClickHouseStore,
  ) {
    this.#db = db;
    this.#userId = userId;
    this.#clickHouse = clickHouse;
  }

  /** Distinct dropdown values for sync history filters scoped to a provider. */
  async getSyncLogFilterOptions(
    providerId: string,
  ): Promise<Record<string, ProviderDetailFilterOption[]>> {
    const entries = await Promise.all(
      Object.entries(SYNC_LOG_FILTER_OPTION_FIELDS).map(async ([apiKey, column]) => {
        assertSqlColumnName(column);
        const rows = await executeWithSchema(
          this.#db,
          distinctValueSchema,
          sql`SELECT DISTINCT ${sql.raw(column)} AS value
              FROM fitness.sync_log
              WHERE user_id = ${this.#userId}
                AND provider_id = ${providerId}
                AND ${sql.raw(column)} IS NOT NULL
              ORDER BY value
              LIMIT ${MAX_DISTINCT_FILTER_OPTIONS}`,
        );
        return [apiKey, rows.map((row) => ({ value: row.value }))] as const;
      }),
    );

    return Object.fromEntries(entries);
  }

  /** Distinct dropdown values for record filters scoped to a provider and data type. */
  async getRecordFilterOptions(
    providerId: string,
    dataType: DataType,
  ): Promise<Record<string, ProviderDetailFilterOption[]>> {
    const columns = getRecordSelectFilterColumns(dataType);
    if (columns.length === 0) {
      return Object.freeze({});
    }

    if (dataType === "bodyMeasurements") {
      return this.#getClickHouseRecordFilterOptions(providerId, tableInfo(dataType).table, columns);
    }

    if (dataType === "metricStream") {
      return this.#getClickHouseRecordFilterOptions(
        providerId,
        tableInfo(dataType).table,
        columns,
        "AND is_deleted = 0",
      );
    }

    const entries = await Promise.all(
      columns.map(async (column) => {
        if (isJournalQuestionSlugFilterColumn(dataType, column)) {
          const options = await this.#queryJournalQuestionSlugOptions(providerId);
          return [column, options] as const;
        }

        const values = await this.#queryDistinctPostgresValues(
          tableInfo(dataType).table,
          providerId,
          column,
        );
        return [column, values.map((value) => ({ value }))] as const;
      }),
    );

    return Object.fromEntries(entries);
  }

  /** Data types that currently have at least one provider record. */
  async getAvailableDataTypes(providerId: string): Promise<DataType[]> {
    if (!this.#clickHouse) {
      throw new Error("providerDetail record availability requires the ClickHouse store");
    }

    const [postgresRows, clickHouseRows] = await Promise.all([
      executeWithSchema(
        this.#db,
        availableDataTypeRowSchema,
        sql`SELECT data_type
            FROM (
              SELECT 'activities'::text AS data_type
              WHERE EXISTS (SELECT 1 FROM fitness.activity WHERE user_id = ${this.#userId} AND provider_id = ${providerId})
              UNION ALL
              SELECT 'dailyMetrics'::text
              WHERE EXISTS (SELECT 1 FROM fitness.daily_metrics WHERE user_id = ${this.#userId} AND provider_id = ${providerId})
              UNION ALL
              SELECT 'sleepSessions'::text
              WHERE EXISTS (SELECT 1 FROM fitness.sleep_session WHERE user_id = ${this.#userId} AND provider_id = ${providerId})
              UNION ALL
              SELECT 'foodEntries'::text
              WHERE EXISTS (SELECT 1 FROM fitness.food_entry WHERE user_id = ${this.#userId} AND provider_id = ${providerId})
              UNION ALL
              SELECT 'healthEvents'::text
              WHERE EXISTS (SELECT 1 FROM fitness.health_event WHERE user_id = ${this.#userId} AND provider_id = ${providerId})
              UNION ALL
              SELECT 'nutritionDaily'::text
              WHERE EXISTS (SELECT 1 FROM fitness.v_nutrition_provider_daily WHERE user_id = ${this.#userId} AND provider_id = ${providerId})
              UNION ALL
              SELECT 'clinicalRecords'::text
              WHERE EXISTS (SELECT 1 FROM fitness.clinical_record WHERE user_id = ${this.#userId} AND provider_id = ${providerId})
              UNION ALL
              SELECT 'journalEntries'::text
              WHERE EXISTS (SELECT 1 FROM fitness.journal_entry WHERE user_id = ${this.#userId} AND provider_id = ${providerId})
            ) AS available_data_types`,
      ),
      this.#clickHouse.query(
        availableDataTypeRowSchema,
        `
          SELECT data_type
          FROM (
            SELECT 'bodyMeasurements' AS data_type
            FROM analytics.v_body_measurement
            WHERE user_id = {userId:UUID}
              AND provider_id = {providerId:String}
            LIMIT 1

            UNION ALL

            SELECT 'metricStream' AS data_type
            FROM ingest.metric_stream
            WHERE user_id = {userId:UUID}
              AND provider_id = {providerId:String}
              AND is_deleted = 0
            LIMIT 1
          )
        `,
        { userId: this.#userId, providerId },
      ),
    ]);

    const available = new Set([...postgresRows, ...clickHouseRows].map((row) => row.data_type));

    return dataTypeEnum.options.filter((dataType) => available.has(dataType));
  }

  /** Paginated records for a provider by data type. */
  async getRecords(
    providerId: string,
    dataType: DataType,
    limit: number,
    offset: number,
    filters: Record<string, string> = {},
  ): Promise<Record<string, unknown>[]> {
    const info = tableInfo(dataType);

    if (dataType === "bodyMeasurements") {
      return this.#queryBodyRecords(providerId, info, limit, offset, undefined, filters);
    }

    if (dataType === "metricStream") {
      return this.#queryMetricStreamRecords(providerId, limit, offset, undefined, filters);
    }

    const filterConditions = buildPostgresFilterConditions(
      filters,
      getRecordFilterColumns(dataType),
    );
    const whereConditions: SQL[] = [
      sql`user_id = ${this.#userId}`,
      sql`provider_id = ${providerId}`,
      ...filterConditions,
    ];

    const query = sql`SELECT ${sql.raw(listColumns(dataType))} FROM ${sql.raw(info.table)}
              WHERE ${sql.join(whereConditions, sql` AND `)}
              ORDER BY ${sql.raw(info.orderColumn)} DESC
              LIMIT ${limit}
              OFFSET ${offset}`;

    return executeWithSchema(this.#db, genericRowSchema, query);
  }

  /** Single record detail with raw data. */
  async getRecordDetail(
    providerId: string,
    dataType: DataType,
    recordId: string,
  ): Promise<Record<string, unknown> | null> {
    const info = tableInfo(dataType);

    if (dataType === "bodyMeasurements") {
      const rows = await this.#queryBodyRecords(providerId, info, 1, 0, recordId);
      return rows[0] ?? null;
    }

    if (dataType === "metricStream") {
      const rows = await this.#queryMetricStreamRecords(providerId, 1, 0, recordId);
      return rows[0] ?? null;
    }

    const query = sql`SELECT * FROM ${sql.raw(info.table)}
              WHERE user_id = ${this.#userId}
                AND provider_id = ${providerId}
                AND ${sql.raw(info.idColumn)} = ${recordId}
              LIMIT 1`;

    const rows = await executeWithSchema(this.#db, genericRowSchema, query);
    return rows[0] ?? null;
  }

  async #queryDistinctPostgresValues(
    table: string,
    providerId: string,
    column: string,
  ): Promise<string[]> {
    assertSqlColumnName(column);
    const rows = await executeWithSchema(
      this.#db,
      distinctValueSchema,
      sql`SELECT DISTINCT ${sql.raw(column)} AS value
          FROM ${sql.raw(table)}
          WHERE user_id = ${this.#userId}
            AND provider_id = ${providerId}
            AND ${sql.raw(column)} IS NOT NULL
          ORDER BY value
          LIMIT ${MAX_DISTINCT_FILTER_OPTIONS}`,
    );
    return rows.map((row) => row.value);
  }

  async #queryJournalQuestionSlugOptions(
    providerId: string,
  ): Promise<ProviderDetailFilterOption[]> {
    const rows = await executeWithSchema(
      this.#db,
      distinctLabeledValueSchema,
      sql`SELECT DISTINCT je.question_slug AS value, jq.display_name AS label
          FROM fitness.journal_entry je
          LEFT JOIN fitness.journal_question jq ON jq.slug = je.question_slug
          WHERE je.user_id = ${this.#userId}
            AND je.provider_id = ${providerId}
            AND je.question_slug IS NOT NULL
          ORDER BY jq.display_name NULLS LAST, je.question_slug
          LIMIT ${MAX_DISTINCT_FILTER_OPTIONS}`,
    );

    return rows.map((row) => ({
      value: row.value,
      ...(row.label ? { label: row.label } : {}),
    }));
  }

  async #getClickHouseRecordFilterOptions(
    providerId: string,
    table: string,
    columns: readonly string[],
    extraWhere = "",
  ): Promise<Record<string, ProviderDetailFilterOption[]>> {
    if (!this.#clickHouse) {
      throw new Error(`providerDetail ${table} filter options require the ClickHouse store`);
    }
    const clickHouse = this.#clickHouse;

    const entries = await Promise.all(
      columns.map(async (column) => {
        assertSqlColumnName(column);
        const rows = await clickHouse.query(
          distinctValueSchema,
          `
            SELECT DISTINCT ${column} AS value
            FROM ${table}
            WHERE user_id = {userId:UUID}
              AND provider_id = {providerId:String}
              AND ${column} IS NOT NULL
              AND toString(${column}) != ''
              ${extraWhere}
            ORDER BY value
            LIMIT {limit:UInt32}
          `,
          {
            userId: this.#userId,
            providerId,
            limit: MAX_DISTINCT_FILTER_OPTIONS,
          },
        );
        return [column, rows.map((row) => ({ value: row.value }))] as const;
      }),
    );

    return Object.fromEntries(entries);
  }

  async #queryBodyRecords(
    providerId: string,
    info: ReturnType<typeof tableInfo>,
    limit: number,
    offset: number,
    recordId?: string,
    filters: Record<string, string> = {},
  ): Promise<Record<string, unknown>[]> {
    if (!this.#clickHouse) {
      throw new Error("providerDetail body measurements require the ClickHouse store");
    }
    const recordFilter = recordId ? "AND toString(id) = {recordId:String}" : "";
    const { clause: filterClause, params: filterParams } = buildClickHouseFilterClauses(
      filters,
      BODY_MEASUREMENT_COLUMNS,
    );
    return this.#clickHouse.query(
      genericRowSchema,
      `
        SELECT *
        FROM ${info.table}
        WHERE user_id = {userId:UUID}
          AND provider_id = {providerId:String}
          ${recordFilter}
          ${filterClause}
        ORDER BY ${info.orderColumn} DESC
        LIMIT {limit:UInt32}
        OFFSET {offset:UInt32}
      `,
      {
        userId: this.#userId,
        providerId,
        ...(recordId ? { recordId } : {}),
        limit,
        offset,
        ...filterParams,
      },
    );
  }

  /**
   * Raw metric-stream rows for a provider, read from the Redpanda-fed ClickHouse
   * mirror (Postgres `fitness.metric_stream` is retired). Version-deduplicated
   * via `row_number()` over `version` (avoids a full-table `FINAL` merge
   * on large continuous streams such as WHOOP heart rate); recorded_at formatted
   * to ISO-8601 Z.
   */
  async #queryMetricStreamRecords(
    providerId: string,
    limit: number,
    offset: number,
    recordId?: string,
    filters: Record<string, string> = {},
  ): Promise<Record<string, unknown>[]> {
    if (!this.#clickHouse) {
      throw new Error("providerDetail metric stream requires the ClickHouse store");
    }
    const recordFilter = recordId ? "AND toString(id) = {recordId:String}" : "";
    const { clause: filterClause, params: filterParams } = buildClickHouseFilterClauses(
      filters,
      METRIC_STREAM_COLUMNS,
    );
    return this.#clickHouse.query(
      genericRowSchema,
      `
        SELECT
          toString(id) AS id,
          -- Raw record view: preserve sub-second precision (%f = microseconds).
          -- Force UTC so the literal 'Z' suffix is accurate regardless of the
          -- column's or server's timezone.
          formatDateTime(recorded_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS recorded_at,
          provider_id,
          external_id,
          device_id,
          source_type,
          channel,
          toString(activity_id) AS activity_id,
          scalar
        FROM (
          SELECT
            id,
            recorded_at,
            provider_id,
            external_id,
            device_id,
            source_type,
            channel,
            activity_id,
            scalar,
            is_deleted,
            row_number() OVER (PARTITION BY id ORDER BY version DESC) AS version_rank
          FROM ingest.metric_stream
          WHERE user_id = {userId:UUID}
            AND provider_id = {providerId:String}
            ${recordFilter}
        ) AS ranked_versions
        WHERE version_rank = 1
          AND is_deleted = 0
          ${filterClause}
        ORDER BY recorded_at DESC
        LIMIT {limit:UInt32}
        OFFSET {offset:UInt32}
      `,
      {
        userId: this.#userId,
        providerId,
        ...(recordId ? { recordId } : {}),
        limit,
        offset,
        ...filterParams,
      },
    );
  }

  /** Verify provider ownership. Returns true if the provider belongs to the user. */
  async verifyOwnership(providerId: string): Promise<boolean> {
    const rows = await executeWithSchema(
      this.#db,
      ownerCheckSchema,
      sql`SELECT provider_id AS id
          FROM fitness.provider_connection
          WHERE provider_id = ${providerId}
            AND user_id = ${this.#userId}
          LIMIT 1`,
    );
    return rows.length > 0;
  }

  /**
   * Whether this user may request provider data deletion.
   * A live connection or an owned canonical record proves access; catalog
   * membership alone is never sufficient.
   */
  async canDeleteProviderData(providerId: string): Promise<boolean> {
    if (await this.verifyOwnership(providerId)) return true;

    const retainedRecordQueries = PROVIDER_DATA_TABLES.map(
      (table) =>
        sql`SELECT 1
            FROM ${sql.raw(table)}
            WHERE provider_id = ${providerId}
              AND user_id = ${this.#userId}`,
    );
    const rows = await executeWithSchema(
      this.#db,
      retainedPostgresDataSchema,
      sql`SELECT EXISTS (
            ${sql.join(retainedRecordQueries, sql` UNION ALL `)}
          ) AS has_data`,
    );
    if (rows[0]?.has_data === true) return true;

    if (!this.#clickHouse) {
      throw new Error("provider data ownership requires the ClickHouse store");
    }
    const metricStreamRows = await this.#clickHouse.query(
      retainedMetricStreamDataSchema,
      `
        SELECT toUInt8(count() > 0) AS has_data
        FROM (
          SELECT id
          FROM ingest.metric_stream
          WHERE user_id = {userId:UUID}
            AND provider_id = {providerId:String}
          GROUP BY id
          HAVING argMax(is_deleted, tuple(version, ingested_at)) = 0
          LIMIT 1
        )
      `,
      { userId: this.#userId, providerId },
    );
    return metricStreamRows[0]?.has_data === 1;
  }

  /** Atomically delete provider records, advance the generation fence, and write the outbox event. */
  async requestProviderDataDeletion(providerId: string): Promise<ProviderDataDeletionRequest> {
    const eventId = randomUUID();
    return this.#db.transaction(async (transaction) => {
      await this.#deleteProviderTablesInTransaction(transaction, providerId, PROVIDER_DATA_TABLES);
      return createProviderDataDeletionRequest(transaction, this.#userId, providerId, eventId);
    });
  }

  async findProviderDataDeletionRequest(
    providerId: string,
    eventId: string,
  ): Promise<ProviderDataDeletionRequestStatus | null> {
    return findProviderDataDeletionRequest(this.#db, this.#userId, providerId, eventId);
  }

  async #deleteProviderTablesInTransaction(
    transaction: ProviderDataDeletionTransaction,
    providerId: string,
    tables: readonly string[],
  ): Promise<void> {
    for (const table of tables) {
      await transaction.execute(
        sql`DELETE FROM ${sql.raw(table)}
            WHERE provider_id = ${providerId} AND user_id = ${this.#userId}`,
      );
    }
  }
}
