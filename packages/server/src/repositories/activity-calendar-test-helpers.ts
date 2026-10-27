import type { Database } from "dofek/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { expect, vi } from "vitest";
import type { ClimbingLogEntryDetail } from "../contracts/climbing-log-contracts.ts";
import type { CalendarActivityEntry } from "./activity-calendar-entry.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { climbingLogDatabaseFixture } from "./climbing-test-helpers.ts";

const dialect = new PgDialect();

type TestDatabaseRow = Record<string, unknown>;

function isQueuedRowSets(
  rowsOrRowSets: TestDatabaseRow[] | TestDatabaseRow[][],
): rowsOrRowSets is TestDatabaseRow[][] {
  return rowsOrRowSets.some(Array.isArray);
}

export function makeDatabase(
  rowsOrRowSets: TestDatabaseRow[] | TestDatabaseRow[][] = [],
  sourceEntries: ClimbingLogEntryDetail[] = [],
) {
  function sourceQueryRows(query: string): TestDatabaseRow[] | null {
    if (query.includes("FROM fitness.user_settings")) return [];
    if (query.includes('AS "activityId"'))
      return sourceEntries.map((entry) => ({
        activityId: entry.activityId,
        memberActivityIds: [entry.activityId],
      }));
    if (query.includes("FROM fitness.v_climbing_log_entry AS entry"))
      return sourceEntries.map(climbingLogDatabaseFixture);
    return null;
  }
  if (isQueuedRowSets(rowsOrRowSets)) {
    const queuedRows = [...rowsOrRowSets];
    const execute = vi.fn().mockImplementation(async (query) => {
      const sourceRows = sourceQueryRows(dialect.sqlToQuery(query).sql);
      if (sourceRows) return sourceRows;
      return queuedRows.shift() ?? [];
    });
    return {
      execute,
    } satisfies Pick<Database, "execute">;
  }

  const execute = vi.fn().mockImplementation(async (query) => {
    const compiled = dialect.sqlToQuery(query);
    const normalizedSql = compiled.sql.replace(/\s+/g, " ");
    const sourceRows = sourceQueryRows(normalizedSql);
    if (sourceRows) return sourceRows;
    const isCanonicalVisibilityQuery =
      normalizedSql.includes("FROM fitness.v_activity") &&
      normalizedSql.includes("id IN") &&
      normalizedSql.includes("user_id =");
    if (isCanonicalVisibilityQuery) {
      const stringParams = compiled.params.filter(
        (param): param is string => typeof param === "string",
      );
      const activityIdCount = (normalizedSql.match(/::uuid/g) ?? []).length - 1;
      return stringParams.slice(1, activityIdCount + 1).map((id) => ({ id }));
    }
    const isVisibleActivityRangeQuery =
      normalizedSql.includes("FROM fitness.v_activity") &&
      normalizedSql.includes("user_id =") &&
      normalizedSql.includes("started_at");
    if (isVisibleActivityRangeQuery) {
      return [{ id: "activity-1" }];
    }
    return [];
  });
  return {
    execute,
  } satisfies Pick<Database, "execute">;
}

export function makeSensorStore(rowSets: Record<string, unknown>[][]): ActivitySensorStore {
  const query = vi.fn();
  for (const rows of rowSets) {
    query.mockImplementationOnce((schema: { parse: (row: Record<string, unknown>) => unknown }) =>
      Promise.resolve(
        rows.map((row) =>
          schema.parse(
            ("canonical_type" in row || "activity_type" in row) && "started_at" in row
              ? {
                  timezone: null,
                  start_utc_offset_minutes: null,
                  end_utc_offset_minutes: null,
                  local_time_source: "unknown",
                  provider_id: "wahoo",
                  primary_activity_id: null,
                  primary_canonical_type: null,
                  primary_provider_id: null,
                  primary_source_name: null,
                  origin_candidate_member_ids: [],
                  origin_evidence: [],
                  member_activity_ids: [],
                  route_activity_id: row.id,
                  modality: null,
                  source_name: null,
                  source_external_ids: [],
                  absent_source_external_ids: [],
                  last_processed_at: null,
                  ...row,
                }
              : row,
          ),
        ),
      ),
    );
  }
  query.mockImplementation((_schema, queryText: string) => {
    if (queryText.includes("analytics.activity_location_member_change")) return Promise.resolve([]);
    throw new Error("Unexpected sensor query");
  });
  return {
    query,
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn().mockResolvedValue([]),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
    getPaceCurveRows: vi.fn().mockResolvedValue([]),
    refreshBodyMeasurements: vi.fn().mockResolvedValue(undefined),
  };
}

export function makeActivityRow<T extends Record<string, unknown>>(overrides?: T) {
  return {
    primary_activity_id: null,
    primary_canonical_type: null,
    primary_provider_id: null,
    primary_source_name: null,
    origin_candidate_member_ids: [],
    origin_evidence: [],
    timezone: null,
    start_utc_offset_minutes: null,
    end_utc_offset_minutes: null,
    local_time_source: "unknown",
    id: "activity-1",
    name: "Trainer Ride",
    canonical_type: "cycling",
    modality: null,
    started_at: "2026-03-18T07:00:00.000Z",
    ended_at: "2026-03-18T08:00:00.000Z",
    provider_id: "wahoo",
    source_name: null,
    member_activity_ids: [],
    source_external_ids: [
      {
        providerId: "wahoo",
        externalId: "wahoo-activity-1",
      },
    ],
    absent_source_external_ids: [],
    last_processed_at: "2026-03-18T08:05:00.000Z",
    duration_min: 60,
    avg_hr: null,
    max_hr: null,
    avg_power: 250,
    total_distance: null,
    elevation_gain_m: null,
    centroid_lat: null,
    centroid_lng: null,
    local_date: new Date("2026-03-18T00:00:00.000Z"),
    ...overrides,
  };
}

export function normalizeSql(queryText: string | undefined): string {
  return queryText?.replace(/\s+/g, " ").trim() ?? "";
}

export function expectDedupedActivitiesWithSummaryMetrics(queryText: string | undefined): void {
  const normalizedQueryText = normalizeSql(queryText);
  expect(normalizedQueryText).toContain("FROM analytics.deduped_activities AS activity FINAL");
  expect(normalizedQueryText).toContain("LEFT JOIN analytics.activity_summary asum");
}

export function expectDedupedActivitiesDriveActivityListIdentity(
  queryText: string | undefined,
): void {
  const normalizedQueryText = normalizeSql(queryText);
  expect(normalizedQueryText).toContain("FROM analytics.deduped_activities AS activity FINAL");
  expect(normalizedQueryText).toContain("LEFT JOIN analytics.activity_summary asum");
  expect(normalizedQueryText).toContain("toString(activity.activity_id) AS id");
  expect(normalizedQueryText).toContain("activity.name AS name");
  expect(normalizedQueryText).toContain("activity.canonical_type AS canonical_type");
  expect(normalizedQueryText).toContain("toString(activity.started_at) AS started_at");
  expect(normalizedQueryText).toContain("toString(activity.ended_at) AS ended_at");
}

export function makeCalendarEntry(
  overrides: Partial<CalendarActivityEntry> & Pick<CalendarActivityEntry, "id" | "startedAt">,
): CalendarActivityEntry {
  return {
    name: overrides.name ?? overrides.id,
    activityType: overrides.activityType ?? "running",
    primaryActivityType: overrides.primaryActivityType ?? null,
    modality: overrides.modality ?? null,
    endedAt: overrides.endedAt ?? overrides.startedAt,
    localTimeContext: overrides.localTimeContext ?? {
      timezone: null,
      startUtcOffsetMinutes: null,
      endUtcOffsetMinutes: null,
      source: "unknown",
    },
    durationMin: overrides.durationMin ?? 60,
    source: overrides.source ?? {
      origin: { status: "unresolved", candidateMemberActivityIds: [] },
      primarySourceLabel: "Wahoo",
      sourceCount: 1,
      overlapSummary: null,
      tree: { primary: null, otherSources: [] },
    },
    lastProcessedAt: overrides.lastProcessedAt ?? "2026-03-18T08:05:00.000Z",
    distanceMeters: overrides.distanceMeters ?? null,
    distanceState: overrides.distanceState ?? {
      status: "missing",
      reason: "Distance not recorded",
    },
    elevationGainM: overrides.elevationGainM ?? null,
    elevationState: overrides.elevationState ?? {
      status: "missing",
      reason: "Elevation gain not recorded",
    },
    location: overrides.location ?? null,
    tss: overrides.tss ?? null,
    stats: overrides.stats ?? [],
    ...overrides,
  };
}
