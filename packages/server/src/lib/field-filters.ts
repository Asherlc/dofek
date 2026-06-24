import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

const SQL_COLUMN_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const FILTER_KEY_PATTERN = /^[a-z][a-zA-Z0-9_]*$/;
const MAX_FIELD_FILTERS = 20;

/** Optional per-column substring filters sent from table UIs. */
export const fieldFiltersSchema = z
  .record(z.string().max(64), z.string().max(500))
  .optional()
  .default({})
  .superRefine((filters, ctx) => {
    if (Object.keys(filters).length > MAX_FIELD_FILTERS) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: MAX_FIELD_FILTERS,
        type: "object",
        inclusive: true,
        message: `At most ${MAX_FIELD_FILTERS} filters are allowed`,
        origin: "array",
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

/** Build Postgres ILIKE conditions for allowlisted snake_case columns. */
export function buildPostgresTextFilterConditions(
  filters: Record<string, string>,
  allowedColumns: ReadonlySet<string> | readonly string[],
): SQL[] {
  const allowed = allowedColumns instanceof Set ? allowedColumns : new Set<string>(allowedColumns);
  const conditions: SQL[] = [];

  for (const [field, value] of normalizeFilters(filters)) {
    if (!allowed.has(field) || !SQL_COLUMN_NAME_PATTERN.test(field)) continue;
    const pattern = `%${escapeLikePattern(value)}%`;
    conditions.push(sql`CAST(${sql.raw(field)} AS TEXT) ILIKE ${pattern}`);
  }

  return conditions;
}

/** Map API field names to DB columns before building Postgres filter conditions. */
export function buildPostgresTextFilterConditionsMapped(
  filters: Record<string, string>,
  fieldToColumn: Record<string, string>,
): SQL[] {
  const mappedFilters: Record<string, string> = {};
  for (const [field, value] of Object.entries(filters)) {
    const column = fieldToColumn[field];
    if (column) mappedFilters[column] = value;
  }
  return buildPostgresTextFilterConditions(mappedFilters, new Set(Object.values(fieldToColumn)));
}

/** Build ClickHouse substring filter clauses for allowlisted columns. */
export function buildClickHouseTextFilterClauses(
  filters: Record<string, string>,
  allowedColumns: readonly string[],
): { clause: string; params: Record<string, string> } {
  const allowed = new Set(allowedColumns);
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  let index = 0;

  for (const [field, value] of normalizeFilters(filters)) {
    if (!allowed.has(field) || !SQL_COLUMN_NAME_PATTERN.test(field)) continue;
    const paramName = `filter_${index}`;
    clauses.push(`positionCaseInsensitive(toString(${field}), {${paramName}:String}) > 0`);
    params[paramName] = value;
    index += 1;
  }

  return {
    clause: clauses.length > 0 ? `AND ${clauses.join(" AND ")}` : "",
    params,
  };
}
