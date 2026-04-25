import { beforeEach, describe, expect, it, vi } from "vitest";

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

function buildPlannerQueryHandler(options: {
  storedViewHash?: string;
  currentFingerprintHash?: string;
  storedFingerprintHash?: string;
  pendingRefreshMigration?: string;
}) {
  return (text: string, _params?: unknown[]) => {
    if (text.includes("FROM drizzle.__view_hashes") && text.includes("view_name = $1")) {
      return Promise.resolve({
        rows: options.storedViewHash
          ? [
              {
                hash: options.storedViewHash,
                dependency_fingerprint_hash: options.storedFingerprintHash ?? null,
              },
            ]
          : [],
      });
    }
    if (text.includes("FROM pg_matviews")) {
      return Promise.resolve({ rows: [{ present: 1 }] });
    }
    if (text.includes("FROM drizzle.__drizzle_migrations")) {
      return Promise.resolve({
        rows: options.pendingRefreshMigration ? [{ hash: options.pendingRefreshMigration }] : [],
      });
    }
    if (text.includes("jsonb_build_object")) {
      return Promise.resolve({
        rows: [{ fingerprint_source: options.currentFingerprintHash ?? "[]" }],
      });
    }
    if (text.includes("UPDATE drizzle.__view_hashes")) {
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  };
}

function upsertedFingerprintParams(): unknown[] | undefined {
  const call = mockClientQuery.mock.calls.find(([text]) =>
    String(text).includes("UPDATE drizzle.__view_hashes"),
  );
  return call?.[1];
}

describe("planMaterializedViewSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientConnect.mockResolvedValue(undefined);
    mockClientEnd.mockResolvedValue(undefined);
    mockClientQuery.mockResolvedValue({ rows: [] });
  });

  it("requires sync when a canonical view hash changed", async () => {
    const { hashViewContent } = await import("./sync-views.ts");
    const { planMaterializedViewSync } = await import("./view-sync-planner.ts");
    const viewSql = "CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1";

    mockReaddirSync.mockReturnValue(["01_v_test.sql"]);
    mockReadFileSync.mockReturnValue(viewSql);
    mockClientQuery.mockImplementation(
      buildPlannerQueryHandler({
        storedViewHash: "old-hash",
        currentFingerprintHash: "same-fingerprint",
        storedFingerprintHash: "same-fingerprint",
      }),
    );

    const plan = await planMaterializedViewSync("postgres://localhost/test", {
      viewsDir: "/tmp/views",
    });

    expect(plan.required).toBe(true);
    expect(plan.reasons).toContain(
      `view_definition_changed:fitness.v_test:${hashViewContent(viewSql)}`,
    );
    expect(upsertedFingerprintParams()).toBeUndefined();
  });

  it("requires sync when a view dependency fingerprint changed", async () => {
    const { hashViewContent } = await import("./sync-views.ts");
    const { planMaterializedViewSync } = await import("./view-sync-planner.ts");
    const viewSql = "CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1";

    mockReaddirSync.mockReturnValue(["01_v_test.sql"]);
    mockReadFileSync.mockReturnValue(viewSql);
    mockClientQuery.mockImplementation(
      buildPlannerQueryHandler({
        storedViewHash: hashViewContent(viewSql),
        currentFingerprintHash: "new-fingerprint",
        storedFingerprintHash: "old-fingerprint",
      }),
    );

    const plan = await planMaterializedViewSync("postgres://localhost/test", {
      viewsDir: "/tmp/views",
    });

    expect(plan).toEqual({
      required: true,
      reasons: ["dependency_fingerprint_changed:fitness.v_test"],
    });
    expect(upsertedFingerprintParams()).toBeUndefined();
  });

  it("records a baseline dependency fingerprint without requiring sync", async () => {
    const { hashViewContent } = await import("./sync-views.ts");
    const { planMaterializedViewSync } = await import("./view-sync-planner.ts");
    const viewSql = "CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1";

    mockReaddirSync.mockReturnValue(["01_v_test.sql"]);
    mockReadFileSync.mockReturnValue(viewSql);
    mockClientQuery.mockImplementation(
      buildPlannerQueryHandler({
        storedViewHash: hashViewContent(viewSql),
        currentFingerprintHash: "current-fingerprint",
      }),
    );

    const plan = await planMaterializedViewSync("postgres://localhost/test", {
      viewsDir: "/tmp/views",
    });

    expect(plan).toEqual({ required: false, reasons: [] });
    expect(upsertedFingerprintParams()).toEqual([
      hashViewContent("current-fingerprint"),
      "fitness.v_test",
    ]);
  });

  it("requires sync when an applied migration explicitly requests materialized view refresh", async () => {
    const { hashViewContent } = await import("./sync-views.ts");
    const { planMaterializedViewSync } = await import("./view-sync-planner.ts");
    const viewSql = "CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1";

    mockReaddirSync.mockReturnValue(["01_v_test.sql"]);
    mockReadFileSync.mockReturnValue(viewSql);
    mockClientQuery.mockImplementation(
      buildPlannerQueryHandler({
        storedViewHash: hashViewContent(viewSql),
        currentFingerprintHash: "same-fingerprint",
        storedFingerprintHash: hashViewContent("same-fingerprint"),
        pendingRefreshMigration: "0007_refresh_views.sql",
      }),
    );

    const plan = await planMaterializedViewSync("postgres://localhost/test", {
      viewsDir: "/tmp/views",
    });

    expect(plan).toEqual({
      required: true,
      reasons: ["migration_requires_materialized_view_refresh:0007_refresh_views.sql"],
    });
  });

  it("closes the database connection", async () => {
    const { planMaterializedViewSync } = await import("./view-sync-planner.ts");

    mockReaddirSync.mockReturnValue([]);

    await planMaterializedViewSync("postgres://localhost/test", {
      viewsDir: "/tmp/views",
    });

    expect(mockClientConnect).toHaveBeenCalled();
    expect(mockClientEnd).toHaveBeenCalled();
  });
});
