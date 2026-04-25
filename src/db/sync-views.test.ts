import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractViewName, hashViewContent } from "./sync-views.ts";

const mockReaddirSync = vi.fn<(path: string) => string[]>().mockReturnValue([]);
const mockReadFileSync = vi.fn<(path: string, encoding: string) => string>().mockReturnValue("");

vi.mock("node:fs", () => ({
  readdirSync: (...args: Parameters<typeof mockReaddirSync>) => mockReaddirSync(...args),
  readFileSync: (...args: Parameters<typeof mockReadFileSync>) => mockReadFileSync(...args),
}));

const { mockClientConnect, mockClientEnd, mockClientQuery, mockClientConstructor } = vi.hoisted(
  () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const connect = vi.fn().mockResolvedValue(undefined);
    const end = vi.fn().mockResolvedValue(undefined);
    const clientInstance = {
      connect,
      end,
      query,
    };
    return {
      mockClientConnect: connect,
      mockClientEnd: end,
      mockClientQuery: query,
      mockClientInstance: clientInstance,
      mockClientConstructor: vi.fn(() => clientInstance),
    };
  },
);

vi.mock("pg", async (importOriginal) => {
  const original = await importOriginal<typeof import("pg")>();
  return {
    ...original,
    Client: mockClientConstructor,
  };
});

function executedQueries(): string[] {
  return mockClientQuery.mock.calls.map(([text]) => String(text));
}

describe("extractViewName", () => {
  it("extracts simple view name", () => {
    expect(extractViewName("CREATE MATERIALIZED VIEW fitness.v_activity AS SELECT 1")).toBe(
      "fitness.v_activity",
    );
  });

  it("extracts view name with IF NOT EXISTS", () => {
    expect(
      extractViewName(
        "CREATE MATERIALIZED VIEW IF NOT EXISTS fitness.activity_summary AS SELECT 1",
      ),
    ).toBe("fitness.activity_summary");
  });

  it("returns null for non-view SQL", () => {
    expect(extractViewName("CREATE TABLE foo (id INT)")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(extractViewName("create materialized view fitness.v_sleep AS SELECT 1")).toBe(
      "fitness.v_sleep",
    );
  });

  it("handles leading comments", () => {
    const sql = "-- Some comment\nCREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1";
    expect(extractViewName(sql)).toBe("fitness.v_test");
  });

  it("returns null for empty string", () => {
    expect(extractViewName("")).toBeNull();
  });

  it("requires MATERIALIZED keyword", () => {
    expect(extractViewName("CREATE VIEW fitness.v_test AS SELECT 1")).toBeNull();
  });

  it("handles extra whitespace between keywords", () => {
    expect(extractViewName("CREATE   MATERIALIZED   VIEW   fitness.v_test AS SELECT 1")).toBe(
      "fitness.v_test",
    );
  });
});

describe("hashViewContent", () => {
  it("produces consistent hashes for same content", () => {
    const sql = "CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1";
    expect(hashViewContent(sql)).toBe(hashViewContent(sql));
  });

  it("ignores leading comment changes", () => {
    const sqlV1 = "-- Version 1\nCREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1";
    const sqlV2 =
      "-- Version 2 with different comment\nCREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1";
    expect(hashViewContent(sqlV1)).toBe(hashViewContent(sqlV2));
  });

  it("produces different hashes for different SQL", () => {
    const sql1 = "CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1";
    const sql2 = "CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 2";
    expect(hashViewContent(sql1)).not.toBe(hashViewContent(sql2));
  });

  it("preserves statement-breakpoint lines", () => {
    const withBreakpoint =
      "CREATE VIEW x AS SELECT 1\n--> statement-breakpoint\nCREATE INDEX idx ON x (id)";
    const withoutBreakpoint = "CREATE VIEW x AS SELECT 1\nCREATE INDEX idx ON x (id)";
    expect(hashViewContent(withBreakpoint)).not.toBe(hashViewContent(withoutBreakpoint));
  });

  it("strips all comment-only lines", () => {
    const withComments = "-- comment 1\n-- comment 2\nSELECT 1";
    const withoutComments = "SELECT 1";
    expect(hashViewContent(withComments)).toBe(hashViewContent(withoutComments));
  });

  it("keeps inline SQL that starts with non-comment content", () => {
    const sql1 = "SELECT 1 -- inline comment";
    const sql2 = "SELECT 1 -- different comment";
    expect(hashViewContent(sql1)).not.toBe(hashViewContent(sql2));
  });

  it("returns a 64-character hex string (SHA-256)", () => {
    const hash = hashViewContent("SELECT 1");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("trims leading/trailing whitespace", () => {
    expect(hashViewContent("  SELECT 1  ")).toBe(hashViewContent("SELECT 1"));
  });
});

describe("syncMaterializedViews", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientConnect.mockResolvedValue(undefined);
    mockClientEnd.mockResolvedValue(undefined);
    mockClientQuery.mockResolvedValue({ rows: [] });
  });

  it("returns zeros when no view files exist", async () => {
    const { syncMaterializedViews } = await import("./sync-views.ts");
    mockReaddirSync.mockReturnValue([]);

    const result = await syncMaterializedViews("postgres://localhost/test", "/tmp/views");

    expect(result).toEqual({ synced: 0, skipped: 0, refreshed: 0 });
    expect(mockClientConstructor).not.toHaveBeenCalled();
  });

  it("skips views whose hash matches and are populated", async () => {
    const { syncMaterializedViews, hashViewContent: hash } = await import("./sync-views.ts");
    const viewSql = "CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1";
    const expectedHash = hash(viewSql);
    const expectedFingerprintHash = hash("[]");

    mockReaddirSync.mockReturnValue(["01_v_test.sql"]);
    mockReadFileSync.mockReturnValue(viewSql);
    mockClientQuery.mockImplementation((text: string) => {
      if (text.includes("FROM drizzle.__view_hashes") && text.includes("view_name = $1")) {
        return Promise.resolve({
          rows: [{ hash: expectedHash, dependency_fingerprint_hash: expectedFingerprintHash }],
        });
      }
      if (text.includes("jsonb_build_object")) {
        return Promise.resolve({ rows: [{ fingerprint_source: "[]" }] });
      }
      if (text.includes("FROM pg_matviews")) {
        return Promise.resolve({ rows: [{ present: 1, populated: true }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await syncMaterializedViews("postgres://localhost/test", "/tmp/views");

    expect(result).toEqual({ synced: 0, skipped: 1, refreshed: 0 });
    expect(executedQueries()).not.toContain(
      'DROP MATERIALIZED VIEW IF EXISTS "fitness"."v_test" CASCADE',
    );
  });

  it("recreates views whose dependency fingerprint changed even when the SQL hash matches", async () => {
    const { syncMaterializedViews, hashViewContent: hash } = await import("./sync-views.ts");
    const viewSql = "CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1";
    const expectedHash = hash(viewSql);

    mockReaddirSync.mockReturnValue(["01_v_test.sql"]);
    mockReadFileSync.mockReturnValue(viewSql);
    mockClientQuery.mockImplementation((text: string) => {
      if (text.includes("FROM drizzle.__view_hashes") && text.includes("view_name = $1")) {
        return Promise.resolve({
          rows: [
            {
              hash: expectedHash,
              dependency_fingerprint_hash: "old-fingerprint",
            },
          ],
        });
      }
      if (text.includes("FROM pg_matviews")) {
        return Promise.resolve({ rows: [{ present: 1, populated: true }] });
      }
      if (text.includes("jsonb_build_object")) {
        return Promise.resolve({ rows: [{ fingerprint_source: "new-fingerprint" }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await syncMaterializedViews("postgres://localhost/test", "/tmp/views");

    expect(result).toEqual({ synced: 1, skipped: 0, refreshed: 0 });
    expect(executedQueries()).toContain(
      'DROP MATERIALIZED VIEW IF EXISTS "fitness"."v_test" CASCADE',
    );
  });

  it("records dependency fingerprints after successful sync", async () => {
    const { syncMaterializedViews, hashViewContent: hash } = await import("./sync-views.ts");
    const viewSql = "CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1";

    mockReaddirSync.mockReturnValue(["01_v_test.sql"]);
    mockReadFileSync.mockReturnValue(viewSql);
    mockClientQuery.mockImplementation((text: string) => {
      if (text.includes("FROM drizzle.__view_hashes") && text.includes("view_name = $1")) {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes("FROM pg_matviews")) {
        return Promise.resolve({ rows: [{ present: 1, populated: true }] });
      }
      if (text.includes("jsonb_build_object")) {
        return Promise.resolve({ rows: [{ fingerprint_source: "new-fingerprint" }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await syncMaterializedViews("postgres://localhost/test", "/tmp/views");

    const insertCall = mockClientQuery.mock.calls.find(([text]) =>
      String(text).includes("INSERT INTO drizzle.__view_hashes"),
    );
    expect(insertCall?.[1]).toEqual(["fitness.v_test", hash(viewSql), hash("new-fingerprint")]);
  });

  it("acknowledges refresh-required migrations after successful sync", async () => {
    const { syncMaterializedViews } = await import("./sync-views.ts");

    mockReaddirSync.mockReturnValue(["01_v_test.sql"]);
    mockReadFileSync.mockReturnValue("CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1");

    await syncMaterializedViews("postgres://localhost/test", "/tmp/views");

    expect(
      executedQueries().some((query) =>
        query.includes("materialized_view_refresh_acknowledged_at = NOW()"),
      ),
    ).toBe(true);
  });

  it("recreates views whose hash matches but were CASCADE-dropped", async () => {
    const { syncMaterializedViews, hashViewContent: hash } = await import("./sync-views.ts");
    const viewSql = "CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1";
    const expectedHash = hash(viewSql);

    mockReaddirSync.mockReturnValue(["01_v_test.sql"]);
    mockReadFileSync.mockReturnValue(viewSql);
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ hash: expectedHash }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ populated: true }] });

    const result = await syncMaterializedViews("postgres://localhost/test", "/tmp/views");

    expect(result).toEqual({ synced: 1, skipped: 0, refreshed: 0 });
    expect(executedQueries()).toContain(
      'DROP MATERIALIZED VIEW IF EXISTS "fitness"."v_test" CASCADE',
    );
    expect(executedQueries()).toContain(viewSql);
  });

  it("refreshes views that are unchanged but unpopulated", async () => {
    const { syncMaterializedViews, hashViewContent: hash } = await import("./sync-views.ts");
    const viewSql = "CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1";
    const expectedHash = hash(viewSql);
    const expectedFingerprintHash = hash("[]");

    mockReaddirSync.mockReturnValue(["01_v_test.sql"]);
    mockReadFileSync.mockReturnValue(viewSql);
    mockClientQuery.mockImplementation((text: string) => {
      if (text.includes("FROM drizzle.__view_hashes") && text.includes("view_name = $1")) {
        return Promise.resolve({
          rows: [{ hash: expectedHash, dependency_fingerprint_hash: expectedFingerprintHash }],
        });
      }
      if (text.includes("jsonb_build_object")) {
        return Promise.resolve({ rows: [{ fingerprint_source: "[]" }] });
      }
      if (text.includes("FROM pg_matviews")) {
        if (text.includes("ispopulated")) {
          return Promise.resolve({ rows: [{ populated: false }] });
        }
        return Promise.resolve({ rows: [{ present: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await syncMaterializedViews("postgres://localhost/test", "/tmp/views");

    expect(result).toEqual({ synced: 0, skipped: 1, refreshed: 1 });
    expect(executedQueries()).toContain('REFRESH MATERIALIZED VIEW "fitness"."v_test"');
  });

  it("recreates views whose hash has changed", async () => {
    const { syncMaterializedViews } = await import("./sync-views.ts");
    const viewSql = "CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1";

    mockReaddirSync.mockReturnValue(["01_v_test.sql"]);
    mockReadFileSync.mockReturnValue(viewSql);
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ hash: "old-hash-that-does-not-match" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ populated: true }] });

    const result = await syncMaterializedViews("postgres://localhost/test", "/tmp/views");

    expect(result).toEqual({ synced: 1, skipped: 0, refreshed: 0 });
    expect(executedQueries()).toContain(
      'DROP MATERIALIZED VIEW IF EXISTS "fitness"."v_test" CASCADE',
    );
    expect(executedQueries()).toContain(viewSql);
  });

  it("creates new views that have no stored hash", async () => {
    const { syncMaterializedViews } = await import("./sync-views.ts");
    const viewSql = "CREATE MATERIALIZED VIEW fitness.v_new AS SELECT 1";

    mockReaddirSync.mockReturnValue(["01_v_new.sql"]);
    mockReadFileSync.mockReturnValue(viewSql);
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ populated: true }] });

    const result = await syncMaterializedViews("postgres://localhost/test", "/tmp/views");

    expect(result).toEqual({ synced: 1, skipped: 0, refreshed: 0 });
    expect(executedQueries()).toContain(
      'DROP MATERIALIZED VIEW IF EXISTS "fitness"."v_new" CASCADE',
    );
  });

  it("processes files in sorted order", async () => {
    const { syncMaterializedViews } = await import("./sync-views.ts");

    mockReaddirSync.mockReturnValue(["02_b.sql", "01_a.sql"]);
    mockReadFileSync
      .mockReturnValueOnce("CREATE MATERIALIZED VIEW fitness.a AS SELECT 1")
      .mockReturnValueOnce("CREATE MATERIALIZED VIEW fitness.b AS SELECT 2");

    await syncMaterializedViews("postgres://localhost/test", "/tmp/views");

    const readCalls = mockReadFileSync.mock.calls.map((call) => call[0]);
    expect(readCalls[0]).toContain("01_a.sql");
    expect(readCalls[1]).toContain("02_b.sql");
  });

  it("splits on statement-breakpoint and executes each statement", async () => {
    const { syncMaterializedViews } = await import("./sync-views.ts");
    const viewSql =
      "CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1\n--> statement-breakpoint\nCREATE UNIQUE INDEX idx ON fitness.v_test (id)";

    mockReaddirSync.mockReturnValue(["01_v_test.sql"]);
    mockReadFileSync.mockReturnValue(viewSql);

    await syncMaterializedViews("postgres://localhost/test", "/tmp/views");

    expect(executedQueries()).toContain(
      'DROP MATERIALIZED VIEW IF EXISTS "fitness"."v_test" CASCADE',
    );
    expect(executedQueries()).toContain("CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1");
    expect(executedQueries()).toContain("CREATE UNIQUE INDEX idx ON fitness.v_test (id)");
  });

  it("skips files that don't contain a CREATE MATERIALIZED VIEW statement", async () => {
    const { syncMaterializedViews } = await import("./sync-views.ts");

    mockReaddirSync.mockReturnValue(["01_not_a_view.sql"]);
    mockReadFileSync.mockReturnValue("CREATE TABLE foo (id INT)");

    const result = await syncMaterializedViews("postgres://localhost/test", "/tmp/views");

    expect(result).toEqual({ synced: 0, skipped: 0, refreshed: 0 });
    expect(executedQueries().some((query) => query.includes("DROP MATERIALIZED VIEW"))).toBe(false);
  });

  it("only processes .sql files", async () => {
    const { syncMaterializedViews } = await import("./sync-views.ts");

    mockReaddirSync.mockReturnValue(["01_v_test.sql", "README.md", "meta.json"]);
    mockReadFileSync.mockReturnValue("CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1");

    await syncMaterializedViews("postgres://localhost/test", "/tmp/views");

    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it("records the hash after successful view creation", async () => {
    const { syncMaterializedViews, hashViewContent: hash } = await import("./sync-views.ts");
    const viewSql = "CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1";
    const expectedHash = hash(viewSql);
    const expectedFingerprintHash = hash("[]");

    mockReaddirSync.mockReturnValue(["01_v_test.sql"]);
    mockReadFileSync.mockReturnValue(viewSql);
    mockClientQuery.mockImplementation((text: string) => {
      if (text.includes("jsonb_build_object")) {
        return Promise.resolve({ rows: [{ fingerprint_source: "[]" }] });
      }
      if (text.includes("FROM pg_matviews")) {
        return Promise.resolve({ rows: [{ populated: true }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await syncMaterializedViews("postgres://localhost/test", "/tmp/views");

    const insertCalls = mockClientQuery.mock.calls.filter(([text]) =>
      String(text).includes("INSERT INTO drizzle.__view_hashes"),
    );
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]?.[1]).toEqual(["fitness.v_test", expectedHash, expectedFingerprintHash]);
  });

  it("does not create a database connection when no files exist", async () => {
    const { syncMaterializedViews } = await import("./sync-views.ts");
    mockClientConstructor.mockClear();
    mockReaddirSync.mockReturnValue([]);

    await syncMaterializedViews("postgres://localhost/test", "/tmp/views");

    expect(mockClientConstructor).not.toHaveBeenCalled();
  });

  it("continues to next view when one view creation fails", async () => {
    const { syncMaterializedViews } = await import("./sync-views.ts");

    mockReaddirSync.mockReturnValue(["01_v_first.sql", "02_v_second.sql"]);
    mockReadFileSync
      .mockReturnValueOnce("CREATE MATERIALIZED VIEW fitness.v_first AS SELECT 1")
      .mockReturnValueOnce("CREATE MATERIALIZED VIEW fitness.v_second AS SELECT 2");
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("No space left on device"))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ populated: true }] });

    await expect(syncMaterializedViews("postgres://localhost/test", "/tmp/views")).rejects.toThrow(
      "Failed to recreate 1 view(s): fitness.v_first",
    );

    expect(executedQueries()).toContain(
      'DROP MATERIALIZED VIEW IF EXISTS "fitness"."v_second" CASCADE',
    );
  });

  it("always closes the connection in finally block", async () => {
    const { syncMaterializedViews } = await import("./sync-views.ts");
    mockReaddirSync.mockReturnValue(["01_test.sql"]);
    mockReadFileSync.mockReturnValue("CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1");
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("db error"));

    await expect(syncMaterializedViews("postgres://localhost/test", "/tmp/views")).rejects.toThrow(
      "db error",
    );

    expect(mockClientEnd).toHaveBeenCalled();
  });
});
