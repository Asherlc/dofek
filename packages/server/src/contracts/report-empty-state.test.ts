import { describe, expect, it } from "vitest";
import { createReportEmptyState } from "./report-empty-state.ts";

describe("report empty-state contract", () => {
  it("describes the exact weekly requirement and only field-backed sections", () => {
    expect(createReportEmptyState("weekly")).toEqual({
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
  });

  it("describes the exact monthly requirement and only field-backed sections", () => {
    expect(createReportEmptyState("monthly")).toEqual({
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
  });
});
