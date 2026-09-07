import { describe, expect, it } from "vitest";
import {
  createReportEmptyState,
  monthlyReportEmptyStateSchema,
  reportEmptyStateSchema,
  weeklyReportEmptyStateSchema,
} from "./report-empty-state.ts";

describe("report empty-state contract", () => {
  it("describes the exact weekly requirement", () => {
    const emptyState = createReportEmptyState("weekly");
    expect(emptyState).toEqual({
      reportKind: "weekly",
      title: "No weekly report for this period.",
      minimumObservedDays: 1,
      acceptedDataTypes: ["activity", "sleep", "recovery"],
      requirement:
        "Sync at least one day of activity, sleep, or recovery data from this period to create a report.",
    });
    expect(weeklyReportEmptyStateSchema.parse(emptyState)).toEqual(emptyState);
  });

  it("describes the exact monthly requirement", () => {
    const emptyState = createReportEmptyState("monthly");
    expect(emptyState).toEqual({
      reportKind: "monthly",
      title: "No monthly report for this period.",
      minimumObservedDays: 1,
      acceptedDataTypes: ["activity", "sleep", "recovery"],
      requirement:
        "Sync at least one day of activity, sleep, or recovery data from this period to create a report.",
    });
    expect(monthlyReportEmptyStateSchema.parse(emptyState)).toEqual(emptyState);
  });

  it("selects the report-kind-specific runtime schema", () => {
    const weekly = createReportEmptyState("weekly");
    const monthly = createReportEmptyState("monthly");

    expect(reportEmptyStateSchema("weekly").parse(weekly)).toEqual(weekly);
    expect(reportEmptyStateSchema("monthly").parse(monthly)).toEqual(monthly);
    expect(reportEmptyStateSchema("weekly").safeParse(monthly).success).toBe(false);
    expect(reportEmptyStateSchema("monthly").safeParse(weekly).success).toBe(false);
  });
});
