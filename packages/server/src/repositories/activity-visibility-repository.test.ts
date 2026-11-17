import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { ActivityVisibilityRepository } from "./activity-visibility-repository.ts";

const dialect = new PgDialect();

function makeRepository(rows: Record<string, unknown>[] = []) {
  const execute = vi.fn().mockResolvedValue(rows);
  const repo = new ActivityVisibilityRepository({ execute }, "user-1", "UTC");
  return { repo, execute };
}

describe("activity visibility", () => {
  it("resolveVisibleActivityIds returns ids present in v_activity", async () => {
    const { repo, execute } = makeRepository([{ id: "activity-1" }]);

    const visibleIds = await repo.resolveVisibleActivityIds(["activity-1", "activity-2"]);

    expect(visibleIds).toEqual(new Set(["activity-1"]));
    const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(compiledQuery.sql).toContain("FROM fitness.v_activity");
    expect(compiledQuery.params).toContain("user-1");
  });

  it("resolveVisibleActivityIds applies the repository access window", async () => {
    const execute = vi.fn().mockResolvedValue([{ id: "activity-1" }]);
    const repo = new ActivityVisibilityRepository({ execute }, "user-1", "UTC", {
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2026-03-10",
      endDateExclusive: "2026-03-17",
    });

    await repo.resolveVisibleActivityIds(["activity-1", "activity-2"]);

    const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(compiledQuery.sql).toContain(
      "started_at >= (CAST($4::date AS timestamp without time zone) AT TIME ZONE $5)",
    );
    expect(compiledQuery.sql).toContain(
      "started_at < (CAST($6::date AS timestamp without time zone) AT TIME ZONE $7)",
    );
    expect(compiledQuery.params).toEqual([
      "user-1",
      "activity-1",
      "activity-2",
      "2026-03-10",
      "UTC",
      "2026-03-17",
      "UTC",
    ]);
  });

  it("listVisibleActivityIdsSince applies the local-date and access windows", async () => {
    const execute = vi.fn().mockResolvedValue([{ id: "activity-1" }]);
    const repo = new ActivityVisibilityRepository({ execute }, "user-1", "America/Los_Angeles", {
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2026-03-10",
      endDateExclusive: "2026-03-17",
    });

    await expect(repo.listVisibleActivityIdsSince("2026-02-01")).resolves.toEqual(["activity-1"]);

    const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(compiledQuery.sql.match(/a\.provider_id = 'mountain-project'/g)).toHaveLength(3);
    expect(compiledQuery.sql).toContain("END >= $10::date");
    expect(compiledQuery.sql).toContain("END >= $19::date");
    expect(compiledQuery.sql).toContain("END < $28::date");
    expect(compiledQuery.sql).toContain("a.start_utc_offset_minutes IS NOT NULL");
    expect(compiledQuery.params).toEqual(
      expect.arrayContaining(["user-1", "2026-02-01", "2026-03-10", "2026-03-17"]),
    );
  });

  it("listVisibleActivityIdsInRange applies an exclusive local-date end", async () => {
    const execute = vi.fn().mockResolvedValue([{ id: "activity-1" }]);
    const repo = new ActivityVisibilityRepository({ execute }, "user-1", "America/Los_Angeles");

    await expect(repo.listVisibleActivityIdsInRange("2026-02-01", "2026-03-01")).resolves.toEqual([
      "activity-1",
    ]);

    const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(compiledQuery.sql.match(/a\.provider_id = 'mountain-project'/g)).toHaveLength(2);
    expect(compiledQuery.sql).toContain("END >= $10::date");
    expect(compiledQuery.sql).toContain("END < $19::date");
    expect(compiledQuery.sql).toContain("a.start_utc_offset_minutes IS NOT NULL");
    expect(compiledQuery.params).toEqual(
      expect.arrayContaining(["user-1", "2026-02-01", "2026-03-01"]),
    );
  });

  it("resolveVisibleActivityIds skips the query when no ids are provided", async () => {
    const { repo, execute } = makeRepository([]);

    const visibleIds = await repo.resolveVisibleActivityIds([]);

    expect(visibleIds).toEqual(new Set());
    expect(execute).not.toHaveBeenCalled();
  });

  it("filterToVisibleActivities keeps only rows visible in v_activity", async () => {
    const { repo } = makeRepository([{ id: "activity-1" }]);

    const filtered = await repo.filterToVisibleActivities([
      { id: "activity-1", name: "Run" },
      { id: "activity-2", name: "Ride" },
    ]);

    expect(filtered).toEqual([{ id: "activity-1", name: "Run" }]);
  });

  it("filters stable group-keyed activity rows through v_activity", async () => {
    const { repo, execute } = makeRepository([{ id: "activity-1" }]);

    const filtered = await repo.filterToVisibleCanonicalActivities([
      { id: "activity-1", name: "Run" },
      { id: "activity-2", name: "Ride" },
    ]);

    expect(filtered).toEqual([{ id: "activity-1", name: "Run" }]);
    const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(compiledQuery.sql).toContain("FROM fitness.v_activity");
    expect(compiledQuery.sql).not.toContain("FROM fitness.activity\n");
  });
});

describe("ActivityVisibilityRepository focused contracts", () => {
  it("resolves selected IDs with deduplication and exact query parameters", async () => {
    const execute = vi.fn().mockResolvedValue([{ id: "activity-1" }]);
    const repository = new ActivityVisibilityRepository({ execute }, "user-1", "UTC");

    await expect(
      repository.resolveVisibleActivityIds(["activity-1", "activity-2", "activity-1"]),
    ).resolves.toEqual(new Set(["activity-1"]));
    const query = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain("FROM fitness.v_activity");
    expect(query.params).toEqual(["user-1", "activity-1", "activity-2"]);
  });

  it("skips the database for an empty ID list", async () => {
    const execute = vi.fn();
    const repository = new ActivityVisibilityRepository({ execute }, "user-1");
    await expect(repository.resolveVisibleActivityIds([])).resolves.toEqual(new Set());
    expect(execute).not.toHaveBeenCalled();
  });

  it("filters row IDs and custom activity IDs through the visible view", async () => {
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

  it("filters canonical IDs using provider date expressions", async () => {
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
