import { describe, expect, it } from "vitest";
import {
  createReportEmptyState,
  monthlyReportEmptyStateSchema,
  reportEmptyStateSchema,
  weeklyReportEmptyStateSchema,
} from "./report-empty-state.ts";

describe("report empty-state contract", () => {
  it("describes the exact weekly requirement and only field-backed sections", () => {
    const emptyState = createReportEmptyState("weekly");
    expect(emptyState).toEqual({
      reportKind: "weekly",
      title: "Your weekly report will appear here",
      message: "No activity, sleep, or recovery data is available for this report yet.",
      minimumObservedDays: 1,
      acceptedDataTypes: ["activity", "sleep", "recovery"],
      requirement:
        "At least 1 observed day of activity, sleep, or recovery data is required to create a weekly report.",
      previewTitle: "When ready, your weekly report will include",
      previewItems: [
        "Training time and activity count",
        "Average nightly sleep",
        "Average resting heart rate",
        "Average heart rate variability",
        "Recent week comparisons",
      ],
      note: "This preview shows report sections only. No personal values or conclusions are estimated.",
    });
    expect(weeklyReportEmptyStateSchema.parse(emptyState)).toEqual(emptyState);
  });

  it("describes the exact monthly requirement and only field-backed sections", () => {
    const emptyState = createReportEmptyState("monthly");
    expect(emptyState).toEqual({
      reportKind: "monthly",
      title: "Your monthly report will appear here",
      message: "No activity, sleep, or recovery data is available for this report yet.",
      minimumObservedDays: 1,
      acceptedDataTypes: ["activity", "sleep", "recovery"],
      requirement:
        "At least 1 observed day of activity, sleep, or recovery data is required to create a monthly report.",
      previewTitle: "When ready, your monthly report will include",
      previewItems: [
        "Training time and activity count",
        "Average daily strain",
        "Average sleep duration",
        "Average resting heart rate",
        "Average heart rate variability",
        "Month-over-month training and sleep changes",
      ],
      note: "This preview shows report sections only. No personal values or conclusions are estimated.",
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
