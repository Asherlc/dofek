import { describe, expect, it, vi } from "vitest";
import {
  buildActivityOriginReadModelRefreshStatements,
  buildActivityReadModelRefreshStatements,
  buildDailyMetricsReadModelRefreshStatements,
  buildProviderStatsCreateReadModelStatements,
  buildSleepQualityMigrationStatements,
} from "./clickhouse-read-models.ts";
import { buildSleepEpisodeAnalysisSelectSql } from "./clickhouse-sleep-episodes.ts";

describe("buildSleepQualityMigrationStatements", () => {
  it("separates the view header from the recursive sleep query", () => {
    expect(buildSleepQualityMigrationStatements().at(-1)).toMatch(
      /^CREATE VIEW IF NOT EXISTS analytics\.v_sleep\s+AS\s+WITH RECURSIVE\b/,
    );
  });
});

describe("buildSleepEpisodeAnalysisSelectSql", () => {
  it("publishes placeholders for the user, inclusive date range, and provider selection", () => {
    const query = buildSleepEpisodeAnalysisSelectSql();
    const bindNames = [...query.matchAll(/\{(\w+):[^}]+\}/g)].map((match) => match[1]);

    expect([...new Set(bindNames)].sort()).toEqual(["endDate", "providers", "startDate", "userId"]);
  });
});

describe("buildActivityReadModelRefreshStatements", () => {
  it("reads the same materialized origin decision as activity cards", () => {
    const view = buildActivityOriginReadModelRefreshStatements()[2];
    expect(view).toContain("FROM analytics.deduped_activities FINAL");
    expect(view).toContain("primary_provider_id");
    expect(view).toContain("representative_activity_id");
    expect(view?.match(/CREATE VIEW/g)).toHaveLength(1);
  });
  it("preserves the column contract used by historical migrations", () => {
    const view = buildActivityOriginReadModelRefreshStatements()[2];
    expect(view).not.toContain("primary_canonical_type");
    expect(view).not.toContain("origins.name");
  });
  it("projects the primary title and nullable type for the current schema", () => {
    const view = buildActivityOriginReadModelRefreshStatements(true)[2];
    expect(view).toContain("origins.name, legacy.name) AS name");
    expect(view).toContain("origins.primary_canonical_type, NULL) AS primary_canonical_type");
  });
  it("drops and recreates the activity read model views", () => {
    const statements = buildActivityReadModelRefreshStatements();

    expect(statements).toEqual([
      "DROP VIEW IF EXISTS analytics.v_activity_members",
      "DROP VIEW IF EXISTS analytics.v_activity",
      expect.stringContaining("CREATE VIEW IF NOT EXISTS analytics.v_activity"),
      expect.stringContaining("CREATE VIEW IF NOT EXISTS analytics.v_activity_members"),
    ]);
    const activityStatement = statements[2];
    if (!activityStatement) {
      throw new Error("Expected activity read model statement");
    }
    const activitySql = activityStatement.replace(/\s+/g, " ");
    expect(activitySql).toContain("active_activity AS");
    expect(activitySql).toContain("absent_source_links AS");
    expect(activitySql).toContain("assumeNotNull(active_activity.group_id) AS group_id");
    expect(activitySql).not.toContain("connected_components AS");
    expect(activitySql).not.toContain("min(toString(connected_activity_id)) AS group_id");
    expect(activitySql).toContain("minIf(ranked.started_at, ranked.id IS NOT NULL)");
    expect(activitySql).toContain("groupArrayIf(final_groups.activity_id, ranked.id IS NOT NULL)");
    expect(activitySql).toContain(
      "coalesce(nullIf(local_time_source, ''), 'unknown') AS local_time_source",
    );
    expect(activitySql).toMatch(
      /tuple\(\s*ranked\.timezone,\s*ranked\.start_utc_offset_minutes,\s*ranked\.end_utc_offset_minutes,\s*ranked\.local_time_source\s*\)/,
    );
    expect(activitySql).not.toContain("argMinIf( ranked.timezone, ranked.priority");
    expect(statements[3]).toContain("arrayJoin(member_activity_ids)");
  });
});

describe("buildDailyMetricsReadModelRefreshStatements", () => {
  it("drops and recreates the daily metrics read model", () => {
    const statements = buildDailyMetricsReadModelRefreshStatements();
    expect(statements).toEqual([
      "DROP VIEW IF EXISTS analytics.v_daily_metrics",
      expect.stringContaining("CREATE VIEW IF NOT EXISTS analytics.v_daily_metrics"),
    ]);
    // A catalog-only parent projects nothing; the projection guard must list
    // every projected column so date-only rows are filtered out.
    expect(statements[1]).toContain("AND (hrv IS NOT NULL");
    expect(statements[1]).toContain("OR skin_temp_c IS NOT NULL)");
  });

  it("rebuilds the projection guard from the full projected-column catalog", async () => {
    vi.resetModules();
    const { buildDailyMetricsReadModelRefreshStatements: refresh } = await import(
      "./clickhouse-read-models.ts"
    );
    expect(refresh()[1]).toContain("AND (hrv IS NOT NULL");
  });
});

describe("buildProviderStatsCreateReadModelStatements", () => {
  it("creates the provider stats read model", () => {
    expect(buildProviderStatsCreateReadModelStatements()).toEqual([
      expect.stringContaining("CREATE VIEW IF NOT EXISTS analytics.provider_stats"),
    ]);
  });
});
