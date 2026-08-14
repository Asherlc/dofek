import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { countRawActivities } from "./raw-activity-count.ts";

describe("countRawActivities", () => {
  it("binds raw activity count filters without broken cast placeholders", async () => {
    const dialect = new PgDialect();
    const renderedQueries: { sql: string; params: unknown[] }[] = [];
    const execute = vi.fn().mockImplementation((query: SQL) => {
      renderedQueries.push(dialect.sqlToQuery(query));
      return Promise.resolve([{ activity_count: 3 }]);
    });

    const count = await countRawActivities(
      { execute },
      {
        userId: "00000000-0000-0000-0000-000000000001",
        days: 30,
        activityTypes: ["cycling"],
        requireEndedAt: true,
        accessWindow: {
          kind: "limited",
          startDate: "2026-01-01T00:00:00.000Z",
          endDateExclusive: "2026-02-01T00:00:00.000Z",
        },
      },
    );

    expect(count).toBe(3);
    expect(renderedQueries).toHaveLength(1);
    const renderedQuery = renderedQueries[0];
    expect(renderedQuery?.sql).toContain("FROM fitness.v_activity");
    expect(renderedQuery?.sql).toContain("CURRENT_TIMESTAMP - $2::int * INTERVAL '1 day'");
    expect(renderedQuery?.sql).toContain("canonical_type IN ($3)");
    expect(renderedQuery?.sql).toContain(
      "started_at >= (CAST($4::date AS timestamp without time zone) AT TIME ZONE $5)",
    );
    expect(renderedQuery?.sql).toContain(
      "started_at < (CAST($6::date AS timestamp without time zone) AT TIME ZONE $7)",
    );
    expect(renderedQuery?.sql).not.toContain("= ::uuid");
    expect(renderedQuery?.sql).not.toContain("- ::int");
    expect(renderedQuery?.params).toEqual([
      "00000000-0000-0000-0000-000000000001",
      30,
      "cycling",
      "2026-01-01T00:00:00.000Z",
      "UTC",
      "2026-02-01T00:00:00.000Z",
      "UTC",
    ]);
  });
});
