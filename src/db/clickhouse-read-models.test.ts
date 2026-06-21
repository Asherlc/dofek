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
    expect(activitySql).toContain("tombstoned AS");
    expect(activitySql).toContain("clusterable AS");
    expect(activitySql).toContain("absent_source_links AS");
    expect(activitySql).toContain("INNER JOIN tombstoned");
    expect(activitySql).toContain(
      "coalesce(any(absent_source_links.absent_source_external_ids), []) AS absent_source_external_ids",
    );
    expect(statements[3]).toContain("arrayJoin(member_activity_ids)");
  });
});
