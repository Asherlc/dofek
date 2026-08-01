import { z } from "zod";

/** States for a server-authored value that is not currently displayable. */
export const activityDataStateUnavailableStatusSchema = z.enum([
  "missing",
  "stale",
  "failed",
  "processing",
  "conflicting",
]);

export const activityDataStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available") }),
  z.object({
    status: activityDataStateUnavailableStatusSchema,
    reason: z.string().trim().min(1),
  }),
]);

export type ActivityDataState = z.infer<typeof activityDataStateSchema>;
export type ActivityDataStateUnavailableStatus = z.infer<
  typeof activityDataStateUnavailableStatusSchema
>;

export type ActivityMetric =
  | { status: "available"; label: string; value: string }
  | { status: ActivityDataStateUnavailableStatus; label: string; reason: string };

export function activityDataStateLabel(status: ActivityDataState["status"]): string {
  return status === "missing" ? "unavailable" : status;
}

export function formatActivityMetric(
  label: string,
  value: number | null,
  state: ActivityDataState,
  formatValue: (value: number) => string,
): ActivityMetric {
  if (state.status !== "available") {
    return { status: state.status, label, reason: state.reason };
  }

  if (value == null) {
    return {
      status: "failed",
      label,
      reason: `${label} was marked available but no value was returned.`,
    };
  }

  return { status: "available", label, value: formatValue(value) };
}
