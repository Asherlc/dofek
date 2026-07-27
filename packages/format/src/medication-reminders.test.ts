import { describe, expect, it } from "vitest";
import {
  findLatestDoseLoggingState,
  MEDICATION_REMINDERS_SETTINGS_KEY,
  medicationReminderSchema,
  medicationRemindersSchema,
  parseLocalTime,
  parseMedicationReminders,
} from "./medication-reminders.ts";

describe("medication reminders settings", () => {
  it("uses a stable settings key", () => {
    expect(MEDICATION_REMINDERS_SETTINGS_KEY).toBe("medicationReminders");
  });

  it("parses a valid reminder", () => {
    expect(
      medicationReminderSchema.parse({
        id: "11111111-1111-4111-8111-111111111111",
        medicationName: "Vitamin D3",
        localTime: "08:30",
        enabled: true,
      }),
    ).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      medicationName: "Vitamin D3",
      localTime: "08:30",
      enabled: true,
    });
  });

  it("rejects empty medication names and invalid local times", () => {
    expect(() =>
      medicationReminderSchema.parse({
        id: "11111111-1111-4111-8111-111111111111",
        medicationName: "   ",
        localTime: "08:30",
        enabled: true,
      }),
    ).toThrow();

    expect(() =>
      medicationReminderSchema.parse({
        id: "11111111-1111-4111-8111-111111111111",
        medicationName: "Vitamin D3",
        localTime: "8:30",
        enabled: true,
      }),
    ).toThrow();

    expect(() =>
      medicationRemindersSchema.parse(
        Array.from({ length: 21 }, (_value, index) => ({
          id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
          medicationName: `Med ${index}`,
          localTime: "09:00",
          enabled: false,
        })),
      ),
    ).toThrow();
  });

  it("parses local time into hour and minute", () => {
    expect(parseLocalTime("08:30")).toEqual({ hour: 8, minute: 30 });
    expect(parseLocalTime("23:05")).toEqual({ hour: 23, minute: 5 });
  });

  it("parses nullish settings values as an empty reminder list", () => {
    expect(parseMedicationReminders(null)).toEqual([]);
    expect(parseMedicationReminders(undefined)).toEqual([]);
    expect(
      parseMedicationReminders([
        {
          id: "11111111-1111-4111-8111-111111111111",
          medicationName: "Vitamin D3",
          localTime: "08:30",
          enabled: true,
        },
      ]),
    ).toEqual([
      {
        id: "11111111-1111-4111-8111-111111111111",
        medicationName: "Vitamin D3",
        localTime: "08:30",
        enabled: true,
      },
    ]);
  });

  it("finds the latest matching imported dose logging state", () => {
    const loggingState = findLatestDoseLoggingState("Vitamin D3", [
      {
        id: "event-older",
        providerId: "apple_health",
        medicationName: "vitamin d3",
        medicationConceptId: null,
        doseStatus: "skipped",
        recordedAt: "2026-07-25T16:00:00.000Z",
        sourceName: "Apple Health",
      },
      {
        id: "event-other",
        providerId: "apple_health",
        medicationName: "Metformin 500 mg",
        medicationConceptId: null,
        doseStatus: "taken",
        recordedAt: "2026-07-26T16:00:00.000Z",
        sourceName: "Apple Health",
      },
      {
        id: "event-newer",
        providerId: "apple_health",
        medicationName: "Vitamin D3",
        medicationConceptId: null,
        doseStatus: "taken",
        recordedAt: "2026-07-26T12:00:00.000Z",
        sourceName: "Apple Health",
      },
    ]);

    expect(loggingState).toEqual({
      doseStatus: "taken",
      recordedAt: "2026-07-26T12:00:00.000Z",
    });
    expect(findLatestDoseLoggingState("Unknown", [])).toBeNull();
  });

  it("trims whitespace when matching medication names for logging state", () => {
    expect(findLatestDoseLoggingState("   ", [])).toBeNull();
    expect(
      findLatestDoseLoggingState("  Vitamin D3  ", [
        {
          id: "event-1",
          providerId: "apple_health",
          medicationName: "  vitamin d3 ",
          medicationConceptId: null,
          doseStatus: "taken",
          recordedAt: "2026-07-25T16:00:00.000Z",
          sourceName: "Apple Health",
        },
      ]),
    ).toEqual({
      doseStatus: "taken",
      recordedAt: "2026-07-25T16:00:00.000Z",
    });
  });
});
