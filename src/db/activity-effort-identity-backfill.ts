import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import type { Database } from "./index.ts";

const MAXIMUM_WINDOW_MILLISECONDS = 31 * 24 * 60 * 60 * 1_000;

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
  external_id: z.string().nullable(),
  group_id: z.string().uuid(),
  id: z.string().uuid(),
  provider_id: z.string().min(1),
  raw: z.record(z.string(), z.unknown()),
});

export interface ActivityEffortIdentityBackfillOptions {
  end: Date;
  execute: boolean;
  start: Date;
  userId: string;
}

export interface ActivityEffortIdentityBackfillResult {
  conflicts: number;
  inserted: number;
  scanned: number;
  skipped: number;
  updated: number;
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
  externalId: string | null;
  providerId: string;
  raw: Record<string, unknown>;
}): ExtractedActivityEffortIdentity[] {
  return activityEffortIdentityFieldMapping.flatMap(({ kind, sourceField }) => {
    const rawValue = raw[sourceField];
    if (typeof rawValue !== "string") return [];
    const value = rawValue.trim();
    if (!value) return [];
    return [{ kind, mappingVersion: "v1", namespace: providerId, sourceField, value }];
  });
}

function validateOptions(options: ActivityEffortIdentityBackfillOptions): void {
  if (!z.string().uuid().safeParse(options.userId).success) {
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

function countConflicts(rows: z.infer<typeof activityRowSchema>[]): number {
  const valuesByGroupAndKind = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const identity of extractActivityEffortIdentities({
      externalId: row.external_id,
      providerId: row.provider_id,
      raw: row.raw,
    })) {
      const key = `${row.group_id}:${identity.namespace}:${identity.kind}:${identity.sourceField}`;
      const values = valuesByGroupAndKind.get(key) ?? new Set<string>();
      values.add(identity.value.replace(/\s+/gu, " ").toLowerCase());
      valuesByGroupAndKind.set(key, values);
    }
  }
  return [...valuesByGroupAndKind.values()].filter((values) => values.size > 1).length;
}

/**
 * Audits bounded stored activity payloads before the dbt-owned identity model
 * refreshes them. It deliberately performs no writes: dbt is the sole writer
 * of analytics.activity_effort_identity.
 */
export async function backfillActivityEffortIdentities(
  db: Pick<Database, "execute">,
  options: ActivityEffortIdentityBackfillOptions,
): Promise<ActivityEffortIdentityBackfillResult> {
  validateOptions(options);
  const rows = await executeWithSchema(
    db,
    activityRowSchema,
    sql`SELECT
      id::text AS id,
      group_id::text AS group_id,
      provider_id,
      external_id,
      raw
    FROM fitness.activity
    WHERE user_id = ${options.userId}::uuid
      AND started_at >= ${options.start}
      AND started_at < ${options.end}
      AND deleted_at IS NULL
      AND provider_absent_at IS NULL
      AND group_id IS NOT NULL
    ORDER BY started_at ASC, id ASC`,
  );
  const skipped = rows.filter(
    (row) =>
      extractActivityEffortIdentities({
        externalId: row.external_id,
        providerId: row.provider_id,
        raw: row.raw,
      }).length === 0,
  ).length;

  return {
    conflicts: countConflicts(rows),
    inserted: 0,
    scanned: rows.length,
    skipped,
    updated: 0,
  };
}
