import { describe, expect, it, vi } from "vitest";
import { CyclingFtpSuggestionsRepository } from "./cycling-ftp-suggestions-repository.ts";

describe("CyclingFtpSuggestionsRepository", () => {
  it("returns separately evidenced reference and 95% 20-minute suggestions within explicit dates", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        activity_id: "ride-1",
        activity_date: "2026-06-10",
        duration_seconds: 1200,
        best_power: 280,
        activity_name: "Long ride",
      },
      {
        activity_id: "ride-2",
        activity_date: "2026-06-11",
        duration_seconds: 600,
        best_power: 330,
        activity_name: "Intervals",
      },
    ]);
    const repository = new CyclingFtpSuggestionsRepository({ query }, "user-1", "UTC");

    const result = await repository.getSuggestions("2026-06-01", "2026-06-15");

    expect(result).toMatchObject({
      start_date: "2026-06-01",
      end_date: "2026-06-15",
      methods: [
        {
          method: "reference_curves",
          evidence: {
            activity_id: "ride-2",
            date: "2026-06-11",
            duration_seconds: 600,
            power_watts: 330,
          },
          limitations: expect.any(String),
        },
        {
          method: "95_percent_best_20_minute",
          suggested_ftp: 266,
          evidence: {
            activity_id: "ride-1",
            date: "2026-06-10",
            duration_seconds: 1200,
            power_watts: 280,
          },
          limitations: expect.any(String),
        },
      ],
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toContain("activity_power_curve");
    expect(query.mock.calls[0]?.[2]).toMatchObject({
      startDate: "2026-06-01",
      endDate: "2026-06-15",
    });
  });

  it("returns explicit unavailable methods when no in-range evidence exists", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const repository = new CyclingFtpSuggestionsRepository({ query }, "user-1", "UTC");
    const result = await repository.getSuggestions("2026-06-01", "2026-06-15");
    expect(result.methods).toEqual([
      expect.objectContaining({
        method: "reference_curves",
        suggested_ftp: null,
        unavailable_reason: expect.any(String),
      }),
      expect.objectContaining({
        method: "95_percent_best_20_minute",
        suggested_ftp: null,
        unavailable_reason: expect.any(String),
      }),
    ]);
  });

  it("does not turn zero or sub-watt efforts into an invalid zero-watt FTP", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        activity_id: "ride-zero",
        activity_date: "2026-06-10",
        duration_seconds: 1200,
        best_power: 0,
        activity_name: null,
      },
      {
        activity_id: "ride-small",
        activity_date: "2026-06-11",
        duration_seconds: 1200,
        best_power: 0.4,
        activity_name: null,
      },
    ]);
    const result = await new CyclingFtpSuggestionsRepository(
      { query },
      "user-1",
      "UTC",
    ).getSuggestions("2026-06-01", "2026-06-15");
    expect(result.methods[1]).toMatchObject({
      suggested_ftp: null,
      evidence: null,
      unavailable_reason: expect.any(String),
    });
  });

  it("states the limits of reference and maximal-effort estimates", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const result = await new CyclingFtpSuggestionsRepository(
      { query },
      "user-1",
      "UTC",
    ).getSuggestions("2026-06-01", "2026-06-15");
    expect(result.methods[0]?.limitations).toContain("not an exact Intervals.icu reproduction");
    expect(result.methods[0]?.limitations).toContain(
      "easy or nonmaximal riding can underestimate FTP",
    );
    expect(result.methods[1]?.limitations).toContain("sufficiently hard, maximal effort");
  });
});
