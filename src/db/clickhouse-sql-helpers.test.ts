import { describe, expect, it } from "vitest";

import { refreshableMergeTreeViewHeader, standardViewHeader } from "./clickhouse-sql-helpers.ts";

describe("standardViewHeader", () => {
  it("creates a ClickHouse view header for a qualified view name", () => {
    expect(
      standardViewHeader("analytics.daily_sleep"),
    ).toBe(`CREATE VIEW IF NOT EXISTS analytics.daily_sleep
AS`);
  });

  it.each(["daily_sleep", "analytics.daily_sleep;", "DROP analytics.daily_sleep"])(
    "rejects invalid qualified view name %s",
    (viewName) => {
      expect(() => standardViewHeader(viewName)).toThrow(
        `Invalid ClickHouse qualified name: ${viewName}`,
      );
    },
  );
});

describe("refreshableMergeTreeViewHeader", () => {
  it("creates a refreshable ClickHouse materialized view header", () => {
    expect(
      refreshableMergeTreeViewHeader("analytics.daily_sleep", "(user_id,date)", "15 MINUTE"),
    ).toBe(`CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.daily_sleep
REFRESH EVERY 15 MINUTE
ENGINE = MergeTree
ORDER BY (user_id,date)
SETTINGS allow_nullable_key = 1
AS`);
  });

  it.each([
    "analytics.daily_sleep; DROP TABLE analytics.activity_summary",
    "raw.analytics.daily_sleep",
  ])("rejects invalid materialized view name %s", (viewName) => {
    expect(() => refreshableMergeTreeViewHeader(viewName, "(user_id, date)", "15 MINUTE")).toThrow(
      `Invalid ClickHouse qualified name: ${viewName}`,
    );
  });

  it.each(["user_id", "(user_id, 1date)", "(user_id, date);"])(
    "rejects invalid order by expression %s",
    (orderBy) => {
      expect(() =>
        refreshableMergeTreeViewHeader("analytics.daily_sleep", orderBy, "15 MINUTE"),
      ).toThrow(`Invalid ClickHouse ORDER BY expression: ${orderBy}`);
    },
  );

  it.each(["0 MINUTE", "15", "15 MINUTES", "15 MINUTE;", "every 15 MINUTE"])(
    "rejects invalid refresh interval %s",
    (refreshEvery) => {
      expect(() =>
        refreshableMergeTreeViewHeader("analytics.daily_sleep", "(user_id, date)", refreshEvery),
      ).toThrow(`Invalid ClickHouse refresh interval: ${refreshEvery}`);
    },
  );
});
