import { describe, expect, it } from "vitest";
import { readModelSql } from "./read-model-sql-test-helpers.ts";

const modelSql = readModelSql("cycling_activity.sql");

describe("cycling_activity model", () => {
  it("preserves nulls when an activity has no aerobic efficiency row", () => {
    expect(modelSql).toContain("'join_use_nulls': 1");
  });
});
