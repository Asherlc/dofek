import {
  isDateFilterColumn,
  isDateTimeFilterColumn,
  isRangeFilterColumn,
  parseRangeFilterKey,
} from "@dofek/filter-columns";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

export const SQL_COLUMN_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export function assertSqlColumnName(column: string): void {
  if (!SQL_COLUMN_NAME_PATTERN.test(column)) {
    throw new Error(`Invalid SQL column name: ${column}`);
  }
}

const FILTER_KEY_PATTERN = /^[a-z][a-zA-Z0-9_]*$/;
const MAX_FIELD_FILTERS = 40;

/** Optional per-column substring filters sent from table UIs. */
export const fieldFiltersSchema = z
  .record(z.string().max(64), z.string().max(500))
  .optional()
  .default({})
  .superRefine((filters, ctx) => {
    if (Object.keys(filters).length > MAX_FIELD_FILTERS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `At most ${MAX_FIELD_FILTERS} filters are allowed`,
      });
    }

    for (const key of Object.keys(filters)) {
      if (!FILTER_KEY_PATTERN.test(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid filter field name: ${key}`,
        });
      }
    }
  });

export function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, (char) => `\\${char}`);
}

function normalizeFilters(filters: Record<string, string>): Array<[string, string]> {
  const normalized: Array<[string, string]> = [];
  for (const [field, rawValue] of Object.entries(filters)) {
    const value = rawValue.trim();
    if (!value) continue;
    normalized.push([field, value]);
  }
  return normalized;
}

const DATETIME_LOCAL_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?$/;

/**
 * Normalize HTML `datetime-local` values (local time without offset) to ISO 8601
 * UTC so Postgres and ClickHouse parse datetime values consistently across environments.
 */
function normalizeDateTimeRangeFilterValues(
  filters: Record<string, string>,
): Record<string, string> {
  const normalized: Record<string, string> = { ...filters };

  for (const [key, value] of Object.entries(filters)) {
    const range = parseRangeFilterKey(key);
    if (!range || !isDateTimeFilterColumn(range.column)) continue;
    if (!DATETIME_LOCAL_REGEX.test(value)) continue;

    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      normalized[key] = date.toISOString();
    }
  }

  return normalized;
}

function resolveApiColumn(key: string, _fieldToColumn?: Record<string, string>): string {
  return key;
}

function resolveDbColumn(apiColumn: string, fieldToColumn?: Record<string, string>): string {
  return fieldToColumn?.[apiColumn] ?? apiColumn;
}

function groupRangeFilters(
  filters: Record<string, string>,
  allowedColumns: ReadonlySet<string>,
  fieldToColumn?: Record<string, string>,
): Map<string, { from?: string; to?: string }> {
  const rangeBounds = new Map<string, { from?: string; to?: string }>();

  for (const [key, value] of normalizeFilters(filters)) {
    const range = parseRangeFilterKey(key);
    if (!range) continue;

    const apiColumn = range.column;
    if (!isRangeFilterColumn(apiColumn)) continue;

    const dbColumn = resolveDbColumn(apiColumn, fieldToColumn);
    if (!allowedColumns.has(dbColumn) || !SQL_COLUMN_NAME_PATTERN.test(dbColumn)) continue;

    const existing = rangeBounds.get(dbColumn) ?? {};
    existing[range.bound] = value;
    rangeBounds.set(dbColumn, existing);
  }

  return rangeBounds;
}

function buildPostgresRangeFilterConditions(
  rangeBounds: Map<string, { from?: string; to?: string }>,
): SQL[] {
  const conditions: SQL[] = [];

  for (const [dbColumn, bounds] of rangeBounds) {
    if (isDateFilterColumn(dbColumn)) {
      if (bounds.from) {
        conditions.push(sql`${sql.raw(dbColumn)} >= ${bounds.from}::date`);
      }
      if (bounds.to) {
        conditions.push(sql`${sql.raw(dbColumn)} <= ${bounds.to}::date`);
      }
      continue;
    }

    if (bounds.from) {
      conditions.push(sql`${sql.raw(dbColumn)} >= ${bounds.from}::timestamptz`);
    }
    if (bounds.to) {
      conditions.push(sql`${sql.raw(dbColumn)} <= ${bounds.to}::timestamptz`);
    }
  }

  return conditions;
}

/** Build Postgres filter conditions for text substring and date/datetime range filters. */
export function buildPostgresFilterConditions(
  filters: Record<string, string>,
  allowedColumns: ReadonlySet<string> | readonly string[],
  fieldToColumn?: Record<string, string>,
): SQL[] {
  const allowed = allowedColumns instanceof Set ? allowedColumns : new Set<string>(allowedColumns);
  const normalizedFilters = normalizeDateTimeRangeFilterValues(filters);
  const rangeBounds = groupRangeFilters(normalizedFilters, allowed, fieldToColumn);
  const rangeColumns = new Set(rangeBounds.keys());
  const conditions = buildPostgresRangeFilterConditions(rangeBounds);

  for (const [key, value] of normalizeFilters(normalizedFilters)) {
    if (parseRangeFilterKey(key)) continue;

    const apiColumn = resolveApiColumn(key, fieldToColumn);
    const dbColumn = resolveDbColumn(apiColumn, fieldToColumn);
    if (!allowed.has(dbColumn) || !SQL_COLUMN_NAME_PATTERN.test(dbColumn)) continue;
    if (rangeColumns.has(dbColumn)) continue;

    const pattern = `%${escapeLikePattern(value)}%`;
    conditions.push(sql`CAST(${sql.raw(dbColumn)} AS TEXT) ILIKE ${pattern}`);
  }

  return conditions;
}

/** Map API field names to DB columns before building Postgres filter conditions. */
export function buildPostgresFilterConditionsMapped(
  filters: Record<string, string>,
  fieldToColumn: Record<string, string>,
): SQL[] {
  return buildPostgresFilterConditions(
    filters,
    new Set(Object.values(fieldToColumn)),
    fieldToColumn,
  );
}

/** Build ClickHouse substring and range filter clauses for allowlisted columns. */
export function buildClickHouseFilterClauses(
  filters: Record<string, string>,
  allowedColumns: readonly string[],
): { clause: string; params: Record<string, string> } {
  const allowed = new Set(allowedColumns);
  const normalizedFilters = normalizeDateTimeRangeFilterValues(filters);
  const rangeBounds = groupRangeFilters(normalizedFilters, allowed);
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  let textIndex = 0;

  for (const [field, value] of normalizeFilters(normalizedFilters)) {
    if (parseRangeFilterKey(field)) continue;
    if (!allowed.has(field) || !SQL_COLUMN_NAME_PATTERN.test(field)) continue;
    if (rangeBounds.has(field)) continue;

    const paramName = `filter_${textIndex}`;
    clauses.push(`positionCaseInsensitive(toString(${field}), {${paramName}:String}) > 0`);
    params[paramName] = value;
    textIndex += 1;
  }

  for (const [column, bounds] of rangeBounds) {
    if (bounds.from) {
      const paramName = `${column}_from`;
      if (isDateFilterColumn(column)) {
        clauses.push(`${column} >= {${paramName}:Date}`);
      } else {
        clauses.push(`${column} >= parseDateTimeBestEffort({${paramName}:String})`);
      }
      params[paramName] = bounds.from;
    }
    if (bounds.to) {
      const paramName = `${column}_to`;
      if (isDateFilterColumn(column)) {
        clauses.push(`${column} <= {${paramName}:Date}`);
      } else {
        clauses.push(`${column} <= parseDateTimeBestEffort({${paramName}:String})`);
      }
      params[paramName] = bounds.to;
    }
  }

  return {
    clause: clauses.length > 0 ? `AND ${clauses.join(" AND ")}` : "",
    params,
  };
}
