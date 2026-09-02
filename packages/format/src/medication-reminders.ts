import { z } from "zod";
import type { MedicationDoseEvent } from "./medication-dose-events.ts";

export const MEDICATION_REMINDERS_SETTINGS_KEY = "medicationReminders";

const localTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "localTime must be HH:mm in 24-hour format");

export const medicationReminderSchema = z.strictObject({
  id: z.string().uuid(),
  medicationName: z.string().trim().min(1).max(200),
  localTime: localTimeSchema,
  enabled: z.boolean(),
});

export const medicationRemindersSchema = z.array(medicationReminderSchema).max(20);

export type MedicationReminder = z.infer<typeof medicationReminderSchema>;

export type MedicationDoseLoggingState = {
  doseStatus: string;
  recordedAt: string;
};

export function parseLocalTime(localTime: string): { hour: number; minute: number } {
  const parsed = localTimeSchema.parse(localTime);
  const [hourText, minuteText] = parsed.split(":");
  return {
    hour: Number(hourText),
    minute: Number(minuteText),
  };
}

export function parseMedicationReminders(value: unknown): MedicationReminder[] {
  if (value == null) return [];
  return medicationRemindersSchema.parse(value);
}

export function findLatestDoseLoggingState(
  medicationName: string,
  events: MedicationDoseEvent[],
): MedicationDoseLoggingState | null {
  const normalizedName = medicationName.trim().toLowerCase();
  if (normalizedName.length === 0) return null;

  let match: MedicationDoseEvent | null = null;
  for (const event of events) {
    if (event.medicationName.trim().toLowerCase() !== normalizedName) continue;
    if (!match || new Date(event.recordedAt).getTime() > new Date(match.recordedAt).getTime()) {
      match = event;
    }
  }
  if (!match) return null;

  return {
    doseStatus: match.doseStatus,
    recordedAt: match.recordedAt,
  };
}
