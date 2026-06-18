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
    expect(statements[2]).toContain("absent_group_members");
    expect(statements[3]).toContain("arrayJoin(member_activity_ids)");
  });
});
