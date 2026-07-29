import path from "node:path";
import { describe, expect, it } from "vitest";
import { REVIEW_SCENARIOS, scanReviewScenarioCoverage } from "./review-scenario-coverage-policy.ts";

const fixtures = path.resolve("scripts/fixtures/review-scenario-coverage-policy");

describe("scanReviewScenarioCoverage", () => {
  it("accepts every named review scenario on web and mobile", () => {
    expect(
      scanReviewScenarioCoverage({
        mobileStoriesDirectory: path.join(fixtures, "complete/mobile"),
        webStoriesDirectory: path.join(fixtures, "complete/web"),
      }),
    ).toEqual({
      missingMobileScenarios: [],
      missingWebScenarios: [],
      mobileScenarioCount: REVIEW_SCENARIOS.length,
      webScenarioCount: REVIEW_SCENARIOS.length,
    });
  });

  it("reports the scenarios missing from each platform independently", () => {
    expect(
      scanReviewScenarioCoverage({
        mobileStoriesDirectory: path.join(fixtures, "incomplete/mobile"),
        webStoriesDirectory: path.join(fixtures, "incomplete/web"),
      }),
    ).toEqual({
      missingMobileScenarios: [
        "conflicting-sources",
        "error",
        "partial-data",
        "processing",
        "stale-provider",
      ],
      missingWebScenarios: [
        "conflicting-sources",
        "empty-data",
        "partial-data",
        "processing",
        "stale-provider",
      ],
      mobileScenarioCount: 1,
      webScenarioCount: 1,
    });
  });

  it("ignores tags that are not attached to exported story objects", () => {
    expect(
      scanReviewScenarioCoverage({
        mobileStoriesDirectory: path.join(fixtures, "not-exported/mobile"),
        webStoriesDirectory: path.join(fixtures, "not-exported/web"),
      }),
    ).toEqual({
      missingMobileScenarios: [...REVIEW_SCENARIOS],
      missingWebScenarios: [...REVIEW_SCENARIOS],
      mobileScenarioCount: 0,
      webScenarioCount: 0,
    });
  });
});
