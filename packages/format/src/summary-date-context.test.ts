import { describe, expect, it } from "vitest";
import { formatSummaryDateContext } from "./summary-date-context.ts";

describe("formatSummaryDateContext", () => {
  it("formats the server-authored effective date with its timezone", () => {
    expect(
      formatSummaryDateContext({
        effectiveDate: "2026-08-02",
        timezone: "America/Los_Angeles",
      }),
    ).toBe("Sun, Aug 2, 2026 · America/Los_Angeles");
  });
});
