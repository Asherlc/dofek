/**
 * Regression guard for activity visibility filters.
 *
 * Keep `provider_absent_at` and `deleted_at` checks paired everywhere we filter
 * visible activities. {@link scanActiveActivityPredicatePairing} enforces this.
 */

const SCANNED_RELATIVE_PATHS = [
  "packages/server/src/repositories/activities-calendar-repository.ts",
  "packages/server/src/repositories/efficiency-repository.ts",
  "packages/server/src/repositories/intervals-repository.ts",
  "packages/server/src/repositories/predictions-repository.ts",
  "packages/server/src/repositories/raw-activity-count.ts",
  "packages/server/src/repositories/strength-repository.ts",
  "packages/server/src/routers/admin.ts",
  "packages/server/src/routers/sync.ts",
  "src/analytics/activity-read-model-build.ts",
  "src/db/clickhouse-read-models.ts",
  "src/export.ts",
  "analytics/models/read_models/activity_source_records.sql",
  "analytics/models/read_models/activity_location_summary_rows.sql",
  "analytics/models/read_models/activity_sensor_summary_rows.sql",
  "analytics/models/read_models/activity_vo2max_estimate.sql",
  "analytics/models/read_models/provider_stats.sql",
  "analytics/models/read_models/sleep_heart_rate_sample.sql",
  "drizzle/_views/01_v_activity.sql",
  "drizzle/_views/07_provider_stats.sql",
] as const;

const PROVIDER_ABSENT_FILTER =
  /provider_absent_at\s+IS\s+(?:NULL|null)(?!\s+AND\s+(?:\w+\.)?deleted_at\s+IS\s+(?:NULL|null))/i;

/**
 * Returns relative paths whose contents mention `provider_absent_at IS NULL`
 * without a paired `deleted_at IS NULL` on the same line or the next line.
 */
export function scanActiveActivityPredicatePairing(
  readFile: (relativePath: string) => string,
): string[] {
  const violations: string[] = [];

  for (const relativePath of SCANNED_RELATIVE_PATHS) {
    const lines = readFile(relativePath).split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      if (!line.includes("provider_absent_at")) continue;

      const sameLinePaired =
        line.includes("provider_absent_at") &&
        line.includes("deleted_at") &&
        !PROVIDER_ABSENT_FILTER.test(line);
      const nextLine = lines[index + 1] ?? "";
      const nextLinePaired =
        PROVIDER_ABSENT_FILTER.test(line) && /deleted_at\s+IS\s+(?:NULL|null)/i.test(nextLine);

      if (PROVIDER_ABSENT_FILTER.test(line) && !sameLinePaired && !nextLinePaired) {
        violations.push(`${relativePath}:${index + 1}`);
      }
    }
  }

  return violations;
}
