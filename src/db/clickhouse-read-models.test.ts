import { describe, expect, it } from "vitest";
import { buildActivityReadModelRefreshStatements } from "./clickhouse-read-models.ts";

describe("buildActivityReadModelRefreshStatements", () => {
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
