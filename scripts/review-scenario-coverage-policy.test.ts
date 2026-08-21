import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
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

  it("requires the generic review tag on the same exported story as the scenario tag", () => {
    expect(
      scanReviewScenarioCoverage({
        mobileStoriesDirectory: path.join(fixtures, "missing-base-tag/mobile"),
        webStoriesDirectory: path.join(fixtures, "missing-base-tag/web"),
      }),
    ).toEqual({
      missingMobileScenarios: [...REVIEW_SCENARIOS],
      missingWebScenarios: [...REVIEW_SCENARIOS],
      mobileScenarioCount: 0,
      webScenarioCount: 0,
    });
  });

  it("does not discover review scenarios inside generated dependency directories", () => {
    const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "review-scenario-policy-"));
    const webRoot = path.join(temporaryRoot, "web");
    const mobileRoot = path.join(temporaryRoot, "mobile");

    try {
      for (const root of [webRoot, mobileRoot]) {
        const dependencyRoot = path.join(root, "node_modules", "generated");
        mkdirSync(dependencyRoot, { recursive: true });
        writeFileSync(
          path.join(dependencyRoot, "Review.stories.tsx"),
          REVIEW_SCENARIOS.map(
            (scenario) =>
              `export const ${scenario.replaceAll("-", "_")} = { tags: ["review-scenario", "review-scenario-${scenario}"] };`,
          ).join("\n"),
        );
      }

      expect(
        scanReviewScenarioCoverage({
          mobileStoriesDirectory: mobileRoot,
          webStoriesDirectory: webRoot,
        }),
      ).toEqual({
        missingMobileScenarios: [...REVIEW_SCENARIOS],
        missingWebScenarios: [...REVIEW_SCENARIOS],
        mobileScenarioCount: 0,
        webScenarioCount: 0,
      });
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });
});
