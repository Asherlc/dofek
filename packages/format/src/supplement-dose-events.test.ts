import { describe, expect, it } from "vitest";
import {
  formatSupplementDoseStatus,
  supplementDoseOccurrencesSchema,
} from "./supplement-dose-events.ts";

describe("supplement dose events", () => {
  it.each([
    ["planned", "Planned"],
    ["taken", "Taken"],
    ["skipped", "Skipped"],
    ["unknown", "Unknown"],
  ] as const)("formats %s status", (status, expected) => {
    expect(formatSupplementDoseStatus(status)).toBe(expected);
  });

  it("rejects unsupported occurrence statuses", () => {
    expect(() =>
      supplementDoseOccurrencesSchema.parse({
        occurrences: [
          {
            currentEventId: "event-1",
            scheduleId: "schedule-1",
            supplementId: "supplement-1",
            supplementName: "Magnesium",
            scheduledDate: "2026-07-27",
            status: "assumed",
            history: [],
          },
        ],
        counts: { planned: 0, taken: 0, skipped: 0, unknown: 0 },
      }),
    ).toThrow();
  });
});
