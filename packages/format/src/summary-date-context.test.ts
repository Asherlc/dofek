import { describe, expect, it, vi } from "vitest";

const { formatDateLongMock } = vi.hoisted(() => ({
  formatDateLongMock: vi.fn(),
}));

vi.mock("./format.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./format.ts")>();
  formatDateLongMock.mockImplementation(actual.formatDateLong);
  return { ...actual, formatDateLong: formatDateLongMock };
});

import { formatSummaryDateContext, summaryDateContextSchema } from "./summary-date-context.ts";

describe("formatSummaryDateContext", () => {
  it("formats the server-authored effective date with its timezone", () => {
    expect(
      formatSummaryDateContext({
        effectiveDate: "2026-08-02",
        timezone: "America/Los_Angeles",
      }),
    ).toBe("Sun, Aug 2, 2026 · America/Los_Angeles");
  });

  it("formats date-only values in UTC before displaying the user timezone", () => {
    formatDateLongMock.mockClear();

    formatSummaryDateContext({
      effectiveDate: "2026-08-02",
      timezone: "America/Los_Angeles",
    });

    expect(formatDateLongMock).toHaveBeenCalledWith("2026-08-02", { timeZone: "UTC" });
  });

  it("rejects impossible calendar dates", () => {
    expect(() =>
      summaryDateContextSchema.parse({
        effectiveDate: "2026-02-29",
        timezone: "America/Los_Angeles",
      }),
    ).toThrow();
  });
});
