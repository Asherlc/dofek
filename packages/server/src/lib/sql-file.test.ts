import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { sqlFile, sqlFileTemplate } from "./sql-file.ts";

describe("sqlFile", () => {
  it("loads static SQL while keeping caller parameters bound by Drizzle", () => {
    const dialect = new PgDialect();
    const query = sql`${sqlFile("./fixtures/sql-file-select.sql", import.meta.url)}
      WHERE id = ${"activity-1"}`;

    const compiledQuery = dialect.sqlToQuery(query);

    expect(compiledQuery.sql).toContain("SELECT name FROM fitness.example");
    expect(compiledQuery.sql).toContain("WHERE id = $1");
    expect(compiledQuery.params).toEqual(["activity-1"]);
  });

  it("interpolates named placeholders with Drizzle SQL chunks", () => {
    const dialect = new PgDialect();
    const template = sqlFileTemplate("./fixtures/sql-file-template.sql", import.meta.url);

    const compiledQuery = dialect.sqlToQuery(
      template({
        rowId: sql`${"activity-1"}`,
        accessPredicate: sql`AND started_at >= ${"2024-01-01"}::date`,
      }),
    );

    expect(compiledQuery.sql).toContain("WHERE id = $1");
    expect(compiledQuery.sql).toContain("AND started_at >= $2::date");
    expect(compiledQuery.params).toEqual(["activity-1", "2024-01-01"]);
  });
});
