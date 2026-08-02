import { describe, expect, it } from "vitest";
import {
  type DataQualityCheckKey,
  type DataQualityCheckStatus,
  getDataQualityDetailItems,
  getDataQualityReview,
  getDataQualityStatusLabel,
} from "./data-quality.ts";

describe("data-quality presentation metadata", () => {
  it.each([
    ["attention", "Needs review"],
    ["informational", "Info"],
    ["healthy", "Ready"],
  ] as const)("labels %s status consistently", (status: DataQualityCheckStatus, label) => {
    expect(getDataQualityStatusLabel(status)).toBe(label);
  });

  it.each([
    ["coverage", "nutrition", "Review nutrition"],
    ["source_overlap", "nutrition", "Review nutrition"],
    ["sync_freshness", "dashboard", "Review dashboard"],
    ["outliers", "dashboard", "Review dashboard"],
    ["manual_edits", "journal", "Review journal"],
  ] as const)("maps %s to the shared review destination", (key: DataQualityCheckKey, destination, label) => {
    expect(getDataQualityReview(key)).toEqual({ destination, label });
  });

  it("assigns distinct keys to repeated detail text", () => {
    expect(getDataQualityDetailItems("coverage", ["Repeated", "Repeated"])).toEqual([
      { key: "coverage-Repeated-0", text: "Repeated" },
      { key: "coverage-Repeated-1", text: "Repeated" },
    ]);
  });
});
