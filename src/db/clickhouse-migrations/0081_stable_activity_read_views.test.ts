import { describe, expect, it } from "vitest";
import { createMigration } from "./0081_stable_activity_read_views.ts";

describe("0081_stable_activity_read_views", () => {
  it("recreates legacy activity views from persisted group membership", () => {
    const migration = createMigration();
    const sql = migration.statements.join("\n");

    expect(migration.id).toBe("0081_stable_activity_read_views");
    expect(migration.statements.slice(0, 2)).toEqual([
      "DROP VIEW IF EXISTS analytics.v_activity_members",
      "DROP VIEW IF EXISTS analytics.v_activity",
    ]);
    expect(sql).toContain("active_activity.group_id");
    expect(sql).toContain("group_id AS id");
    expect(sql).toContain("tombstoned_groups AS");
    expect(sql).toContain("final_groups.group_id NOT IN (SELECT group_id FROM tombstoned_groups)");
    expect(sql).not.toContain("min(toString(connected_activity_id)) AS group_id");
    expect(sql).not.toContain("connected_components AS");
  });
});
