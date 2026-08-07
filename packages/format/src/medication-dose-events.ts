import { z } from "zod";

export const medicationDoseEventSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  medicationName: z.string(),
  medicationConceptId: z.string().nullable(),
  doseStatus: z.string(),
  recordedAt: z.string(),
  sourceName: z.string().nullable(),
});

export type MedicationDoseEvent = z.infer<typeof medicationDoseEventSchema>;

export function formatDoseStatus(status: string): string {
  const normalized = status.trim();
  if (normalized.length === 0) return "Unknown";
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}
