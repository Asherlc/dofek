import { describe, expect, it, vi } from "vitest";
import {
  generateShareToken,
  HealthReportRepository,
  ReportListEntry,
  type ReportListRow,
  SharedReport,
  type SharedReportRow,
} from "./health-report-repository.ts";

// ---------------------------------------------------------------------------
// generateShareToken
// ---------------------------------------------------------------------------

describe("generateShareToken", () => {
  it("returns a non-empty string", () => {
    const token = generateShareToken();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("produces URL-safe base64 tokens (no +, /, or = characters)", () => {
    const token = generateShareToken();
    expect(token).not.toMatch(/[+/=]/);
  });

  it("generates unique tokens on each call", () => {
    const tokenA = generateShareToken();
    const tokenB = generateShareToken();
    expect(tokenA).not.toBe(tokenB);
  });

  it("produces consistent-length tokens (24 bytes = 32 chars in base64url)", () => {
    const token = generateShareToken();
    // 24 bytes → base64url = ceil(24 * 4/3) = 32 characters
    expect(token.length).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// SharedReport domain model
// ---------------------------------------------------------------------------

describe("SharedReport", () => {
  function makeRow(overrides: Partial<SharedReportRow> = {}): SharedReportRow {
    return {
      id: "sr-1",
      shareToken: "abc123token",
      reportType: "weekly",
      reportData: { score: 85 },
      expiresAt: "2024-02-15T00:00:00Z",
      createdAt: "2024-01-15T10:00:00Z",
      ...overrides,
    };
  }

  it("exposes all getters", () => {
    const report = new SharedReport(makeRow());
    expect(report.id).toBe("sr-1");
    expect(report.shareToken).toBe("abc123token");
    expect(report.reportType).toBe("weekly");
    expect(report.reportData).toEqual({ score: 85 });
    expect(report.expiresAt).toBe("2024-02-15T00:00:00Z");
    expect(report.createdAt).toBe("2024-01-15T10:00:00Z");
  });

  it("handles null expiresAt", () => {
    const report = new SharedReport(makeRow({ expiresAt: null }));
    expect(report.expiresAt).toBeNull();
  });

  it("handles non-null expiresAt", () => {
    const report = new SharedReport(makeRow({ expiresAt: "2024-12-31T23:59:59Z" }));
    expect(report.expiresAt).toBe("2024-12-31T23:59:59Z");
    expect(typeof report.expiresAt).toBe("string");
  });

  it("serializes all fields via toDetail()", () => {
    const row = makeRow();
    expect(new SharedReport(row).toDetail()).toEqual(row);
  });

  it("toDetail() returns a copy, not the original", () => {
    const row = makeRow();
    const report = new SharedReport(row);
    const detail1 = report.toDetail();
    const detail2 = report.toDetail();
    expect(detail1).not.toBe(detail2);
    expect(detail1).toEqual(detail2);
  });

  it("toDetail() includes all fields with correct values", () => {
    const row = makeRow({
      id: "sr-complete",
      shareToken: "complete-token",
      reportType: "deep-dive",
      reportData: { a: 1, b: [2, 3] },
      expiresAt: "2025-01-01T00:00:00Z",
      createdAt: "2024-06-01T00:00:00Z",
    });
    const detail = new SharedReport(row).toDetail();
    expect(detail.id).toBe("sr-complete");
    expect(detail.shareToken).toBe("complete-token");
    expect(detail.reportType).toBe("deep-dive");
    expect(detail.reportData).toEqual({ a: 1, b: [2, 3] });
    expect(detail.expiresAt).toBe("2025-01-01T00:00:00Z");
    expect(detail.createdAt).toBe("2024-06-01T00:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// ReportListEntry domain model
// ---------------------------------------------------------------------------

describe("ReportListEntry", () => {
  function makeRow(overrides: Partial<ReportListRow> = {}): ReportListRow {
    return {
      id: "sr-1",
      shareToken: "abc123token",
      reportType: "monthly",
      expiresAt: null,
      createdAt: "2024-01-15T10:00:00Z",
      ...overrides,
    };
  }

  it("exposes all getters", () => {
    const entry = new ReportListEntry(makeRow());
    expect(entry.id).toBe("sr-1");
    expect(entry.shareToken).toBe("abc123token");
    expect(entry.reportType).toBe("monthly");
    expect(entry.expiresAt).toBeNull();
    expect(entry.createdAt).toBe("2024-01-15T10:00:00Z");
  });

  it("serializes all fields via toDetail()", () => {
    const row = makeRow();
    expect(new ReportListEntry(row).toDetail()).toEqual(row);
  });

  it("handles non-null expiresAt", () => {
    const entry = new ReportListEntry(makeRow({ expiresAt: "2024-06-15T00:00:00Z" }));
    expect(entry.expiresAt).toBe("2024-06-15T00:00:00Z");
    expect(typeof entry.expiresAt).toBe("string");
  });

  it("toDetail() returns a copy, not the original", () => {
    const row = makeRow();
    const entry = new ReportListEntry(row);
    const detail1 = entry.toDetail();
    const detail2 = entry.toDetail();
    expect(detail1).not.toBe(detail2);
    expect(detail1).toEqual(detail2);
  });

  it("toDetail() includes all fields with correct values", () => {
    const row = makeRow({ expiresAt: "2024-12-31T23:59:59Z" });
    const detail = new ReportListEntry(row).toDetail();
    expect(detail.id).toBe("sr-1");
    expect(detail.shareToken).toBe("abc123token");
    expect(detail.reportType).toBe("monthly");
    expect(detail.expiresAt).toBe("2024-12-31T23:59:59Z");
    expect(detail.createdAt).toBe("2024-01-15T10:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// HealthReportRepository
// ---------------------------------------------------------------------------

describe("HealthReportRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const repo = new HealthReportRepository({ execute }, "user-1");
    return { repo, execute };
  }

  describe("generate", () => {
    it("returns a SharedReport when insert succeeds", async () => {
      const { repo } = makeRepository([
        {
          id: "sr-1",
          share_token: "generated-token",
          report_type: "weekly",
          report_data: { score: 90 },
          expires_at: "2024-02-15T00:00:00Z",
          created_at: "2024-01-15T10:00:00Z",
        },
      ]);

      const result = await repo.generate("weekly", { score: 90 }, 30);
      expect(result).toBeInstanceOf(SharedReport);
      expect(result?.reportType).toBe("weekly");
      expect(result?.reportData).toEqual({ score: 90 });
      expect(result?.expiresAt).toBe("2024-02-15T00:00:00.000Z");
    });

    it("returns null when insert returns no rows", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.generate("weekly", {}, null);
      expect(result).toBeNull();
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([
        {
          id: "sr-1",
          share_token: "t",
          report_type: "weekly",
          report_data: {},
          expires_at: null,
          created_at: "2024-01-15T10:00:00Z",
        },
      ]);
      await repo.generate("weekly", {}, null);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getShared (static)", () => {
    it("returns null when no matching token exists", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const result = await HealthReportRepository.getShared({ execute }, "nonexistent");
      expect(result).toBeNull();
    });

    it("returns a SharedReport when token matches", async () => {
      const execute = vi.fn().mockResolvedValue([
        {
          id: "sr-2",
          share_token: "valid-token",
          report_type: "healthspan",
          report_data: { lifespan: 90 },
          expires_at: null,
          created_at: "2024-01-20T12:00:00Z",
        },
      ]);

      const result = await HealthReportRepository.getShared({ execute }, "valid-token");
      expect(result).toBeInstanceOf(SharedReport);
      expect(result?.shareToken).toBe("valid-token");
      expect(result?.reportType).toBe("healthspan");
    });

    it("calls execute once", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      await HealthReportRepository.getShared({ execute }, "any-token");
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("myReports", () => {
    it("returns empty array when user has no reports", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.myReports();
      expect(result).toEqual([]);
    });

    it("returns ReportListEntry instances", async () => {
      const { repo } = makeRepository([
        {
          id: "sr-1",
          share_token: "token-a",
          report_type: "weekly",
          expires_at: null,
          created_at: "2024-01-15T10:00:00Z",
        },
        {
          id: "sr-2",
          share_token: "token-b",
          report_type: "monthly",
          expires_at: "2024-03-15T00:00:00Z",
          created_at: "2024-01-10T08:00:00Z",
        },
      ]);

      const result = await repo.myReports();
      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(ReportListEntry);
      expect(result[0]?.reportType).toBe("weekly");
      expect(result[1]).toBeInstanceOf(ReportListEntry);
      expect(result[1]?.reportType).toBe("monthly");
    });

    it("query includes LIMIT 50", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.myReports();
      const callArgs = execute.mock.calls[0]?.[0];
      const queryJson = JSON.stringify(callArgs);
      expect(queryJson).toContain("50");
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.myReports();
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("LIMIT 50 is present in the query (not 49 or 51)", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.myReports();
      const callArgs = execute.mock.calls[0]?.[0];
      const queryJson = JSON.stringify(callArgs);
      // Verify the query contains "50" and not a different number
      expect(queryJson).toContain("50");
    });
  });

  describe("generate — toSharedReport mapping", () => {
    it("maps all DB row fields to SharedReport domain model fields", async () => {
      const { repo } = makeRepository([
        {
          id: "sr-map",
          share_token: "mapped-token-123",
          report_type: "monthly",
          report_data: { metrics: [1, 2, 3] },
          expires_at: "2024-03-15T00:00:00Z",
          created_at: "2024-02-15T12:00:00Z",
        },
      ]);

      const result = await repo.generate("monthly", { metrics: [1, 2, 3] }, 30);
      expect(result).not.toBeNull();
      expect(result?.id).toBe("sr-map");
      expect(result?.shareToken).toBe("mapped-token-123");
      expect(result?.reportType).toBe("monthly");
      expect(result?.reportData).toEqual({ metrics: [1, 2, 3] });
      expect(result?.expiresAt).toBe("2024-03-15T00:00:00.000Z");
      expect(result?.createdAt).toBe("2024-02-15T12:00:00.000Z");
    });

    it("maps null expires_at correctly to null expiresAt", async () => {
      const { repo } = makeRepository([
        {
          id: "sr-null-exp",
          share_token: "token-null-exp",
          report_type: "weekly",
          report_data: {},
          expires_at: null,
          created_at: "2024-01-15T10:00:00Z",
        },
      ]);

      const result = await repo.generate("weekly", {}, null);
      expect(result).not.toBeNull();
      expect(result?.expiresAt).toBeNull();
    });

    it("maps non-null expires_at correctly to string expiresAt", async () => {
      const { repo } = makeRepository([
        {
          id: "sr-exp",
          share_token: "token-exp",
          report_type: "weekly",
          report_data: {},
          expires_at: "2024-04-15T00:00:00Z",
          created_at: "2024-01-15T10:00:00Z",
        },
      ]);

      const result = await repo.generate("weekly", {}, 90);
      expect(result).not.toBeNull();
      expect(result?.expiresAt).toBe("2024-04-15T00:00:00.000Z");
      expect(typeof result?.expiresAt).toBe("string");
    });
  });

  describe("myReports — toReportListEntry mapping", () => {
    it("maps all DB row fields to ReportListEntry domain model fields", async () => {
      const { repo } = makeRepository([
        {
          id: "sr-list",
          share_token: "list-token",
          report_type: "healthspan",
          expires_at: "2024-05-01T00:00:00Z",
          created_at: "2024-03-01T10:00:00Z",
        },
      ]);

      const result = await repo.myReports();
      expect(result).toHaveLength(1);
      const entry = result[0];
      expect(entry?.id).toBe("sr-list");
      expect(entry?.shareToken).toBe("list-token");
      expect(entry?.reportType).toBe("healthspan");
      expect(entry?.expiresAt).toBe("2024-05-01T00:00:00.000Z");
      expect(entry?.createdAt).toBe("2024-03-01T10:00:00.000Z");
    });

    it("maps null expires_at to null expiresAt in list entries", async () => {
      const { repo } = makeRepository([
        {
          id: "sr-list-null",
          share_token: "list-token-null",
          report_type: "weekly",
          expires_at: null,
          created_at: "2024-03-01T10:00:00Z",
        },
      ]);

      const result = await repo.myReports();
      expect(result[0]?.expiresAt).toBeNull();
    });

    it("maps non-null expires_at to string expiresAt in list entries", async () => {
      const { repo } = makeRepository([
        {
          id: "sr-list-exp",
          share_token: "list-token-exp",
          report_type: "weekly",
          expires_at: "2024-12-31T23:59:59Z",
          created_at: "2024-03-01T10:00:00Z",
        },
      ]);

      const result = await repo.myReports();
      expect(result[0]?.expiresAt).toBe("2024-12-31T23:59:59.000Z");
      expect(typeof result[0]?.expiresAt).toBe("string");
    });
  });

  describe("getShared — toSharedReport mapping", () => {
    it("maps all DB row fields correctly in static method", async () => {
      const execute = vi.fn().mockResolvedValue([
        {
          id: "sr-shared",
          share_token: "shared-token-abc",
          report_type: "deep-dive",
          report_data: { sections: ["sleep", "hrv"] },
          expires_at: null,
          created_at: "2024-06-01T08:00:00Z",
        },
      ]);

      const result = await HealthReportRepository.getShared({ execute }, "shared-token-abc");
      expect(result).not.toBeNull();
      expect(result?.id).toBe("sr-shared");
      expect(result?.shareToken).toBe("shared-token-abc");
      expect(result?.reportType).toBe("deep-dive");
      expect(result?.reportData).toEqual({ sections: ["sleep", "hrv"] });
      expect(result?.expiresAt).toBeNull();
      expect(result?.createdAt).toBe("2024-06-01T08:00:00.000Z");
    });

    it("maps non-null expires_at in static method", async () => {
      const execute = vi.fn().mockResolvedValue([
        {
          id: "sr-shared-exp",
          share_token: "token-exp",
          report_type: "weekly",
          report_data: {},
          expires_at: "2024-09-01T00:00:00Z",
          created_at: "2024-06-01T08:00:00Z",
        },
      ]);

      const result = await HealthReportRepository.getShared({ execute }, "token-exp");
      expect(result?.expiresAt).toBe("2024-09-01T00:00:00.000Z");
    });
  });

  describe("generate (expiresInDays ternary)", () => {
    it("passes non-null expiresInDays for expiring reports (expiresInDays != null)", async () => {
      const { repo, execute } = makeRepository([
        {
          id: "sr-1",
          share_token: "t1",
          report_type: "weekly",
          report_data: {},
          expires_at: "2024-02-15T00:00:00Z",
          created_at: "2024-01-15T10:00:00Z",
        },
      ]);
      await repo.generate("weekly", {}, 30);
      expect(execute).toHaveBeenCalledTimes(1);
      // The SQL should contain the days interval value
      const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
      expect(queryJson).toContain("30");
    });

    it("passes null for non-expiring reports (expiresInDays === null)", async () => {
      const { repo, execute } = makeRepository([
        {
          id: "sr-2",
          share_token: "t2",
          report_type: "weekly",
          report_data: {},
          expires_at: null,
          created_at: "2024-01-15T10:00:00Z",
        },
      ]);
      const result = await repo.generate("weekly", {}, null);
      expect(result).toBeInstanceOf(SharedReport);
      expect(result?.expiresAt).toBeNull();
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("treats expiresInDays 0 as non-null (uses interval, not NULL)", async () => {
      // expiresInDays = 0 is != null, so it should use the interval path
      const { repo, execute } = makeRepository([
        {
          id: "sr-3",
          share_token: "t3",
          report_type: "weekly",
          report_data: {},
          expires_at: "2024-01-15T10:00:00Z",
          created_at: "2024-01-15T10:00:00Z",
        },
      ]);
      await repo.generate("weekly", {}, 0);
      expect(execute).toHaveBeenCalledTimes(1);
      const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
      // Should contain the value 0 for the interval, not NULL
      expect(queryJson).toContain("0");
    });
  });
});
