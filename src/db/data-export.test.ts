import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { listQueuedDataExportRequests } from "./data-export.ts";
import type { Database } from "./typed-sql.ts";

const exportId = "10000000-0000-4000-8000-000000000025";
const userId = "20000000-0000-4000-8000-000000000025";

describe("listQueuedDataExportRequests", () => {
  it("validates, maps, and limits queued export rows", async () => {
    const execute = vi.fn(async (_query: SQL) => [{ id: exportId, user_id: userId }]);
    const database = { execute } satisfies Database;

    await expect(listQueuedDataExportRequests(database, 2)).resolves.toEqual([
      { exportId, userId },
    ]);

    const query = execute.mock.calls[0]?.[0];
    if (!query) {
      throw new Error("Expected a queued-export query");
    }
    const compiled = new PgDialect().sqlToQuery(query);
    expect(compiled.sql.replaceAll(/\s+/g, " ").trim()).toBe(
      "SELECT export.id, export.user_id FROM fitness.data_export AS export WHERE export.status = 'queued' AND NOT EXISTS ( SELECT 1 FROM fitness.account_erasure_request AS erasure WHERE erasure.user_id = export.user_id AND erasure.status <> 'completed' ) ORDER BY export.created_at, export.id LIMIT $1",
    );
    expect(compiled.params).toEqual([2]);
  });

  it("rejects invalid database rows and unsafe batch limits", async () => {
    const database = {
      execute: vi.fn(async (_query: SQL) => [{ id: "not-a-uuid", user_id: userId }]),
    } satisfies Database;

    await expect(listQueuedDataExportRequests(database, 1)).rejects.toThrow();
    await expect(listQueuedDataExportRequests(database, 1_001)).rejects.toThrow();
  });
});
