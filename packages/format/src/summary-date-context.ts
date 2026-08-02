import { z } from "zod";
import { formatDateLong } from "./format.ts";

export const summaryDateContextSchema = z.object({
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().min(1),
});

export type SummaryDateContext = z.infer<typeof summaryDateContextSchema>;

/** Format a server-authored calendar date together with the timezone that defines it. */
export function formatSummaryDateContext(context: SummaryDateContext): string {
  return `${formatDateLong(context.effectiveDate, { timeZone: "UTC" })} · ${context.timezone}`;
}
