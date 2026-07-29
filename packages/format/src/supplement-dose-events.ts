import { z } from "zod";

export const supplementDoseStatusSchema = z.enum(["planned", "taken", "skipped", "unknown"]);

export type SupplementDoseStatus = z.infer<typeof supplementDoseStatusSchema>;

export const supplementDoseHistoryEventSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  status: supplementDoseStatusSchema,
  recordedAt: z.string(),
  sourceName: z.string().nullable(),
});

export const supplementDoseOccurrenceSchema = z.object({
  currentEventId: z.string(),
  scheduleId: z.string(),
  supplementId: z.string(),
  supplementName: z.string(),
  scheduledDate: z.string(),
  status: supplementDoseStatusSchema,
  history: z.array(supplementDoseHistoryEventSchema),
});

export const supplementDoseOccurrencesSchema = z.object({
  occurrences: z.array(supplementDoseOccurrenceSchema),
  counts: z.object({
    planned: z.number().int().nonnegative(),
    taken: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  }),
});

export type SupplementDoseOccurrence = z.infer<typeof supplementDoseOccurrenceSchema>;
export type SupplementDoseOccurrences = z.infer<typeof supplementDoseOccurrencesSchema>;

export function formatSupplementDoseStatus(status: SupplementDoseStatus): string {
  switch (status) {
    case "planned":
      return "Planned";
    case "taken":
      return "Taken";
    case "skipped":
      return "Skipped";
    case "unknown":
      return "Unknown";
  }
}
