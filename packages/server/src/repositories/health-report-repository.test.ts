import { describe, expect, it, vi } from "vitest";
import {
  HealthReportRepository,
  ReportListEntry,
  type ReportListRow,
  SharedReport,
  type SharedReportRow,
} from "./health-report-repository.ts";

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

  it("serializes all fields via toDetail()", () => {
    const row = makeRow();
    expect(new SharedReport(row).toDetail()).toEqual(row);
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

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.myReports();
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });
});
