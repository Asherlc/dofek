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

/** Keep average/maximum pairs together without hiding independent data states. */
export function groupActivityMetrics<T extends { label: string; status?: string }>(
  metrics: readonly T[],
): Array<{ primary: T; secondary: T | null }> {
  const visible = metrics.filter((metric) => metric.status !== "missing");
  const pairs = new Map([
    ["Avg Heart Rate", "Max Heart Rate"],
    ["Avg Power", "Max Power"],
  ]);
  const groupedLabels = new Set(
    [...pairs]
      .filter(([average]) => visible.some((metric) => metric.label === average))
      .map(([, maximum]) => maximum),
  );
  return visible
    .filter((metric) => !groupedLabels.has(metric.label))
    .map((primary) => ({
      primary,
      secondary: visible.find((metric) => metric.label === pairs.get(primary.label)) ?? null,
    }));
}

export function activityDataStateLabel(status: ActivityDataState["status"]): string {
  return status === "missing" ? "unavailable" : status;
}

export function formatActivityMetric(
  label: string,
  value: number | null,
  state: ActivityDataState | null | undefined,
  formatValue: (value: number) => string,
): ActivityMetric {
  if (state == null) {
    return value == null
      ? { status: "missing", label, reason: `${label} is unavailable.` }
      : { status: "available", label, value: formatValue(value) };
  }

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
