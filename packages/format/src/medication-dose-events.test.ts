import { describe, expect, it } from "vitest";
import { formatDoseStatus, medicationDoseEventSchema } from "./medication-dose-events.ts";

describe("medicationDoseEventSchema", () => {
  it("parses medication dose events shared by web and mobile", () => {
    expect(
      medicationDoseEventSchema.parse({
        id: "event-1",
        providerId: "apple_health",
        medicationName: "Metformin 500 mg",
        medicationConceptId: "rxnorm-123",
        doseStatus: "taken",
        recordedAt: "2026-06-29T15:30:00.000Z",
        sourceName: "Apple Health",
      }),
    ).toEqual({
      id: "event-1",
      providerId: "apple_health",
      medicationName: "Metformin 500 mg",
      medicationConceptId: "rxnorm-123",
      doseStatus: "taken",
      recordedAt: "2026-06-29T15:30:00.000Z",
      sourceName: "Apple Health",
    });
  });
});

describe("formatDoseStatus", () => {
  it("formats status labels for medication dose event badges", () => {
    expect(formatDoseStatus("taken")).toBe("Taken");
    expect(formatDoseStatus(" skipped")).toBe("Skipped");
    expect(formatDoseStatus("")).toBe("Unknown");
  });
});
