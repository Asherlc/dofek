import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import type { Database } from "./index.ts";

const MAXIMUM_WINDOW_MILLISECONDS = 31 * 24 * 60 * 60 * 1_000;
const MAXIMUM_AUDIT_DETAILS = 100;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

const activityEffortIdentityFieldMapping = [
  { kind: "provider_workout", sourceField: "pelotonClassId" },
  { kind: "provider_workout", sourceField: "templateId" },
  { kind: "provider_workout", sourceField: "workoutTemplateId" },
  { kind: "provider_workout", sourceField: "classId" },
  { kind: "provider_route", sourceField: "routeId" },
  { kind: "provider_route", sourceField: "courseId" },
  { kind: "segment", sourceField: "segmentId" },
  { kind: "standardized_test", sourceField: "standardizedTestId" },
  { kind: "standardized_test", sourceField: "testId" },
] as const;

const activityRowSchema = z.object({
  group_id: z.uuid().nullable(),
  id: z.uuid(),
  provider_id: z.string().min(1),
  raw: z.record(z.string(), z.unknown()).nullable(),
});

export interface ActivityEffortIdentityAuditOptions {
  end: Date;
  start: Date;
  userId: string;
}

export interface ActivityEffortIdentityAuditResult {
  conflicts: number;
  details: ActivityEffortIdentityAuditDetail[];
  detailsTruncated: boolean;
  refreshReady: boolean;
  scanned: number;
  skipped: number;
}

export interface ActivityEffortIdentityAuditDetail {
  activityId: string;
  canonicalGroupId: string | null;
  distinctValueCount: number;
  kind: "conflict" | "invalid_group_id" | "unsupported";
  providerId: string;
  sourceField: string;
  valueTypes: string[];
}

export interface ExtractedActivityEffortIdentity {
  kind: (typeof activityEffortIdentityFieldMapping)[number]["kind"];
  mappingVersion: "v1";
  namespace: string;
  sourceField: (typeof activityEffortIdentityFieldMapping)[number]["sourceField"];
  value: string;
}

export function extractActivityEffortIdentities({
  providerId,
  raw,
}: {
  providerId: string;
  raw: Record<string, unknown> | null;
}): ExtractedActivityEffortIdentity[] {
  if (raw === null) return [];
  return activityEffortIdentityFieldMapping.flatMap(({ kind, sourceField }) => {
    const rawValue = raw[sourceField];
    if (typeof rawValue !== "string") return [];
    const value = rawValue.trim();
    if (!value) return [];
    return [{ kind, mappingVersion: "v1", namespace: providerId, sourceField, value }];
  });
}

function validateOptions(options: ActivityEffortIdentityAuditOptions): void {
  if (!z.uuid().safeParse(options.userId).success) {
    throw new Error("userId must be a UUID");
  }
  if (Number.isNaN(options.start.getTime()) || Number.isNaN(options.end.getTime())) {
    throw new Error("start and end must be valid dates");
  }
  if (options.start.getTime() >= options.end.getTime()) {
    throw new Error("start must be before end");
  }
  if (options.end.getTime() - options.start.getTime() > MAXIMUM_WINDOW_MILLISECONDS) {
    throw new Error("Backfill window must not exceed 31 days");
  }
}

type ActivityRow = z.infer<typeof activityRowSchema>;

interface IdentityClaim {
  identity: ExtractedActivityEffortIdentity;
  row: ActivityRow;
}

function makeDetail(
  row: ActivityRow,
  kind: ActivityEffortIdentityAuditDetail["kind"],
  sourceField: string,
  values: unknown[],
): ActivityEffortIdentityAuditDetail {
  const valueTypes = [
    ...new Set(
      values.map((value) => {
        if (value === null) return "null";
        if (Array.isArray(value)) return "array";
        return typeof value;
      }),
    ),
  ].sort();
  return {
    activityId: row.id,
    canonicalGroupId: row.group_id,
    distinctValueCount: new Set(values).size,
    kind,
    providerId: row.provider_id,
    sourceField,
    valueTypes,
  };
}

function hasCanonicalGroupId(row: ActivityRow): row is ActivityRow & { group_id: string } {
  return row.group_id !== null && row.group_id !== ZERO_UUID;
}

function unsupportedDetails(row: ActivityRow): ActivityEffortIdentityAuditDetail[] {
  if (row.raw === null) return [makeDetail(row, "unsupported", "raw", [null])];
  const entries = Object.entries(row.raw);
  if (entries.length === 0) return [makeDetail(row, "unsupported", "raw", [{}])];
  return entries.map(([sourceField, value]) =>
    makeDetail(row, "unsupported", sourceField, [value]),
  );
}

function collectConflicts(rows: ActivityRow[]): {
  conflicts: number;
  details: ActivityEffortIdentityAuditDetail[];
} {
  const claimsByGroupAndKind = new Map<string, IdentityClaim[]>();
  for (const row of rows) {
    for (const identity of extractActivityEffortIdentities({
      providerId: row.provider_id,
      raw: row.raw,
    })) {
      const key = `${row.group_id}:${identity.namespace}:${identity.kind}:${identity.sourceField}`;
      const claims = claimsByGroupAndKind.get(key) ?? [];
      claims.push({ identity, row });
      claimsByGroupAndKind.set(key, claims);
    }
  }
  const details: ActivityEffortIdentityAuditDetail[] = [];
  let conflicts = 0;
  for (const claims of claimsByGroupAndKind.values()) {
    const normalizedValues = new Set(
      claims.map(({ identity }) => identity.value.replace(/\s+/gu, " ").toLowerCase()),
    );
    if (normalizedValues.size < 2) continue;
    conflicts++;
    const values = [...new Set(claims.map(({ identity }) => identity.value))];
    for (const { identity, row } of claims) {
      details.push(makeDetail(row, "conflict", identity.sourceField, values));
    }
  }
  return { conflicts, details };
}

/**
 * Audits bounded stored activity payloads before the dbt-owned identity model
 * refreshes them. It deliberately performs no writes: dbt is the sole writer
 * of analytics.activity_effort_identity.
 */
export async function auditActivityEffortIdentities(
  db: Pick<Database, "execute">,
  options: ActivityEffortIdentityAuditOptions,
): Promise<ActivityEffortIdentityAuditResult> {
  validateOptions(options);
  const rows = await executeWithSchema(
    db,
    activityRowSchema,
    sql`SELECT
      id::text AS id,
      group_id::text AS group_id,
      provider_id,
      raw
    FROM fitness.activity
    WHERE user_id = ${options.userId}::uuid
      AND started_at >= ${options.start}
      AND started_at < ${options.end}
      AND deleted_at IS NULL
      AND provider_absent_at IS NULL
    ORDER BY started_at ASC, id ASC`,
  );
  const invalidGroupRows = rows.filter((row) => !hasCanonicalGroupId(row));
  const validGroupRows = rows.filter(hasCanonicalGroupId);
  const skippedRows = rows.filter(
    (row) =>
      extractActivityEffortIdentities({
        providerId: row.provider_id,
        raw: row.raw,
      }).length === 0,
  );
  const { conflicts, details: conflictDetails } = collectConflicts(validGroupRows);
  const details = [
    ...invalidGroupRows.map((row) =>
      makeDetail(row, "invalid_group_id", "group_id", [row.group_id]),
    ),
    ...skippedRows.flatMap(unsupportedDetails),
    ...conflictDetails,
  ];

  return {
    conflicts,
    details: details.slice(0, MAXIMUM_AUDIT_DETAILS),
    detailsTruncated: details.length > MAXIMUM_AUDIT_DETAILS,
    refreshReady: invalidGroupRows.length === 0,
    scanned: rows.length,
    skipped: skippedRows.length,
  };
}
