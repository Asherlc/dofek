import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { ActivityVisibilityRepository } from "./activity-visibility-repository.ts";

const dialect = new PgDialect();

describe("ActivityVisibilityRepository", () => {
  it("resolves only IDs present in the visible activity view", async () => {
    const execute = vi.fn().mockResolvedValue([{ id: "activity-1" }]);
    const repository = new ActivityVisibilityRepository({ execute }, "user-1", "UTC");

    await expect(
      repository.resolveVisibleActivityIds(["activity-1", "activity-2", "activity-1"]),
    ).resolves.toEqual(new Set(["activity-1"]));
    const query = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain("FROM fitness.v_activity");
    expect(query.params).toEqual(["user-1", "activity-1", "activity-2"]);
  });

  it("skips the database when resolving an empty ID list", async () => {
    const execute = vi.fn();
    const repository = new ActivityVisibilityRepository({ execute }, "user-1");

    await expect(repository.resolveVisibleActivityIds([])).resolves.toEqual(new Set());
    expect(execute).not.toHaveBeenCalled();
  });

  it("filters both row IDs and custom activity IDs through the view", async () => {
    const execute = vi.fn().mockResolvedValue([{ id: "activity-1" }]);
    const repository = new ActivityVisibilityRepository({ execute }, "user-1");

    await expect(
      repository.filterToVisibleActivities(
        [
          { activity_id: "activity-1", label: "visible" },
          { activity_id: "activity-2", label: "hidden" },
        ],
        (row) => row.activity_id,
      ),
    ).resolves.toEqual([{ activity_id: "activity-1", label: "visible" }]);
  });

  it("filters visible canonical IDs using the calendar date expression", async () => {
    const execute = vi.fn().mockResolvedValue([{ id: "activity-1" }]);
    const repository = new ActivityVisibilityRepository({ execute }, "user-1", "UTC", {
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2026-07-01",
      endDateExclusive: "2026-07-08",
    });

    await expect(
      repository.filterToVisibleCanonicalActivities([
        { id: "activity-1", label: "visible" },
        { id: "activity-2", label: "hidden" },
      ]),
    ).resolves.toEqual([{ id: "activity-1", label: "visible" }]);
    const query = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain("provider_id = 'mountain-project'");
  });
});
