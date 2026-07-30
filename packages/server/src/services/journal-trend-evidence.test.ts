import { describe, expect, it } from "vitest";
import type { JournalEntryDetail } from "../repositories/journal-repository.ts";
import { buildJournalTrendEvidence } from "./journal-trend-evidence.ts";

function entry(
  input: Partial<JournalEntryDetail> &
    Pick<JournalEntryDetail, "date" | "question_slug" | "answer_numeric">,
): JournalEntryDetail {
  return {
    id: `${input.question_slug}-${input.date}-${input.source?.providerId ?? "dofek"}`,
    display_name: input.question_slug,
    category: "wellness",
    data_type: "numeric",
    unit: null,
    answer_text: null,
    impact_score: null,
    source: { providerId: "dofek", label: "Dofek" },
    ...input,
  };
}

describe("buildJournalTrendEvidence", () => {
  it("returns daily gaps, exact observations, visible bounds, and descriptive evidence", () => {
    const evidence = buildJournalTrendEvidence({
      days: 5,
      endDate: "2026-07-05",
      entries: [
        entry({
          date: "2026-07-03",
          question_slug: "alcohol",
          display_name: "Alcohol",
          data_type: "boolean",
          answer_numeric: 0,
          source: { providerId: "whoop", label: "WHOOP (Cloud)" },
        }),
        entry({
          date: "2026-07-01",
          question_slug: "alcohol",
          display_name: "Alcohol",
          data_type: "boolean",
          answer_numeric: 1,
          source: { providerId: "dofek", label: "Dofek" },
        }),
        entry({
          date: "2026-07-04",
          question_slug: "energy",
          display_name: "Energy",
          data_type: "numeric",
          unit: "/10",
          answer_numeric: 8,
        }),
      ],
    });

    expect(evidence.window).toEqual({
      startDate: "2026-07-01",
      endDate: "2026-07-05",
      dayCount: 5,
      gapRepresentation: "explicit_daily",
    });
    expect(evidence.statement).toBe(
      "3 exact observations across 3 of 5 days. Missing days indicate no journal value was recorded.",
    );
    expect(evidence.uncertainty).toEqual({
      status: "unavailable",
      statement: "Uncertainty interval: not available for raw journal observations.",
    });
    expect(evidence.series).toHaveLength(2);

    expect(evidence.series[0]).toMatchObject({
      questionSlug: "alcohol",
      displayName: "Alcohol",
      dataType: "boolean",
      unit: null,
      observationCount: 2,
      observedDayCount: 2,
      missingDayCount: 3,
      statement: "2 exact observations across 2 of 5 days; 3 days have no recorded value.",
      points: [
        {
          date: "2026-07-01",
          value: 1,
          source: { providerId: "dofek", label: "Dofek" },
        },
        { date: "2026-07-02", value: null, source: null },
        {
          date: "2026-07-03",
          value: 0,
          source: { providerId: "whoop", label: "WHOOP (Cloud)" },
        },
        { date: "2026-07-04", value: null, source: null },
        { date: "2026-07-05", value: null, source: null },
      ],
    });
    expect(evidence.series[1]).toMatchObject({
      questionSlug: "energy",
      displayName: "Energy",
      dataType: "numeric",
      unit: "/10",
      statement: "1 exact observation across 1 of 5 days; 4 days have no recorded value.",
    });
  });

  it("preserves multiple raw provider observations on the same date", () => {
    const evidence = buildJournalTrendEvidence({
      days: 2,
      endDate: "2026-07-05",
      entries: [
        entry({
          date: "2026-07-05",
          question_slug: "energy",
          answer_numeric: 7,
          source: { providerId: "dofek", label: "Dofek" },
        }),
        entry({
          date: "2026-07-05",
          question_slug: "energy",
          answer_numeric: 8,
          source: { providerId: "whoop", label: "WHOOP (Cloud)" },
        }),
      ],
    });

    expect(evidence.series[0]?.points).toEqual([
      { date: "2026-07-04", value: null, source: null },
      {
        date: "2026-07-05",
        value: 7,
        source: { providerId: "dofek", label: "Dofek" },
      },
      {
        date: "2026-07-05",
        value: 8,
        source: { providerId: "whoop", label: "WHOOP (Cloud)" },
      },
    ]);
    expect(evidence.series[0]).toMatchObject({
      observationCount: 2,
      observedDayCount: 1,
      missingDayCount: 1,
    });
  });

  it("keeps all-history evidence sparse while preserving its full date bounds and counts", () => {
    const evidence = buildJournalTrendEvidence({
      days: null,
      endDate: "2026-07-05",
      entries: [
        entry({
          date: "2006-06-28",
          question_slug: "energy",
          answer_numeric: 6,
        }),
      ],
    });

    expect(evidence.window).toEqual({
      startDate: "2006-06-28",
      endDate: "2026-07-05",
      dayCount: 7313,
      gapRepresentation: "count_only",
    });
    expect(evidence.series[0]?.missingDayCount).toBe(7312);
    expect(evidence.series[0]?.points).toEqual([
      {
        date: "2006-06-28",
        value: 6,
        source: { providerId: "dofek", label: "Dofek" },
      },
    ]);
  });

  it("returns an honest empty statement and finite date window", () => {
    const evidence = buildJournalTrendEvidence({
      days: 3,
      endDate: "2026-07-05",
      entries: [],
    });

    expect(evidence).toMatchObject({
      window: {
        startDate: "2026-07-03",
        endDate: "2026-07-05",
        dayCount: 3,
        gapRepresentation: "explicit_daily",
      },
      statement: "No numeric or Yes/No journal observations in this window.",
      series: [],
      uncertainty: {
        status: "unavailable",
        statement: "Uncertainty interval: not available for raw journal observations.",
      },
    });
  });
});
