import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { listAccountErasurePostgresIdentifierPages } from "./postgres-identifier-capture.ts";

const userId = "10000000-0000-4000-8000-000000000001";
const id = (index: number) => `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

async function collectPages(
  execute: Parameters<typeof listAccountErasurePostgresIdentifierPages>[0]["execute"],
) {
  const pages = [];
  for await (const page of listAccountErasurePostgresIdentifierPages({ execute }, userId))
    pages.push(page);
  return pages;
}

describe("listAccountErasurePostgresIdentifierPages", () => {
  it("keeps full-page continuation and each identifier family separate", async () => {
    const full = Array.from({ length: 500 }, (_, index) => ({ id: id(index) }));
    const execute = vi
      .fn()
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce([{ id: id(500) }])
      .mockResolvedValueOnce([{ id: id(0) }])
      .mockResolvedValueOnce([{ id: id(0) }]);
    const pages = await collectPages(execute);
    expect(pages).toEqual([
      { family: "activity", identifiers: full.map((row) => row.id) },
      { family: "activity", identifiers: [id(500)] },
      { family: "sleep", identifiers: [id(0)] },
      { family: "operation", identifiers: [id(0)] },
    ]);
    expect(execute).toHaveBeenCalledTimes(4);
    const queries = execute.mock.calls.map(([query]) => {
      if (!(query instanceof SQL)) throw new Error("Expected a typed root query");
      return new PgDialect().sqlToQuery(query);
    });
    // Static SQL admission policy; the companion real-PG suite executes the
    // ownership, UNION deduplication and keyset behavior against seeded rows.
    expect(queries.map((query) => query.params)).toEqual([
      [...Array(6).fill(userId), 500],
      [...Array(6).fill(userId), id(499), 500],
      [userId, 500],
      [userId, 500],
    ]);
    expect(queries[0]?.sql).toContain("fitness.activity_group_alias");
    expect(queries[1]?.sql).toContain("WHERE id>");
    expect(queries[0]?.sql).not.toContain("WHERE id>");
    expect(queries[2]?.sql).toContain("fitness.sleep_session");
    expect(queries[3]?.sql).toContain("fitness.processing_operation");
  });

  it("finishes empty families without yielding empty encryption pages", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    expect(await collectPages(execute)).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("finishes an exact full page only after checking its empty continuation", async () => {
    const full = Array.from({ length: 500 }, (_, index) => ({ id: id(index) }));
    const execute = vi.fn().mockResolvedValue([]).mockResolvedValueOnce(full);
    expect(await collectPages(execute)).toEqual([
      { family: "activity", identifiers: full.map((row) => row.id) },
    ]);
    expect(execute).toHaveBeenCalledTimes(4);
  });
});
