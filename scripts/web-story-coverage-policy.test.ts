import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  NON_VISUAL_COMPONENT_EXEMPTIONS,
  scanWebStoryCoverage,
} from "./web-story-coverage-policy.ts";

const fixtures = path.resolve("scripts/fixtures/web-story-coverage-policy");

describe("scanWebStoryCoverage", () => {
  it("accepts visual components with colocated stories", () => {
    expect(scanWebStoryCoverage(path.join(fixtures, "complete"), new Set())).toEqual({
      missingStories: [],
      staleExemptions: [],
      visualComponentCount: 1,
    });
  });

  it("reports missing stories in sorted order", () => {
    expect(scanWebStoryCoverage(path.join(fixtures, "missing"), new Set())).toEqual({
      missingStories: ["Alpha.tsx", "Contest.tsx", "Zulu.tsx"],
      staleExemptions: [],
      visualComponentCount: 3,
    });
  });

  it("rejects an exemption after its component receives a story", () => {
    expect(
      scanWebStoryCoverage(path.join(fixtures, "stale-exemption"), new Set(["Provider"])),
    ).toEqual({
      missingStories: [],
      staleExemptions: ["Provider"],
      visualComponentCount: 1,
    });
  });

  it("keeps the production exemption list limited to non-visual providers and boundaries", () => {
    expect([...NON_VISUAL_COMPONENT_EXEMPTIONS].sort()).toEqual([
      "DashboardLayoutProvider",
      "QueryErrorBoundary",
      "UnitProvider",
    ]);
  });
});
