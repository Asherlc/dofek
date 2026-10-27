import type { ActivityDataState } from "@dofek/format/activity-data-state";

/** Describe whether a server-computed activity measurement can be displayed. */
export function activityMeasurementState(label: string, value: number | null): ActivityDataState {
  return value == null
    ? { status: "missing", reason: `${label} not recorded` }
    : { status: "available" };
}
