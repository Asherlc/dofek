import { gradeSystemLabel } from "@dofek/training/climbing-grades";
import type { AttemptOutcome, ClimbingAttempt, GradeComponent } from "@dofek/training/climbing-log";
import type { GpsCoordinates } from "@dofek/training/gps-coordinates";
import { formatClimbingAttemptCount, formatClimbingRopeMethod } from "./climbing-context.ts";

export function formatClimbingRecordedResult(
  target: string,
  outcome: AttemptOutcome | null,
  recordedCount: number,
): string {
  return `${target}${outcome === null ? "" : ` ${outcome}`} · ${formatClimbingAttemptCount(recordedCount)}`;
}

export function formatClimbingRopeMethods(
  attempts: readonly Pick<ClimbingAttempt, "ropeMethod">[],
): string | null {
  const labels = new Set(
    attempts
      .map((attempt) => formatClimbingRopeMethod(attempt.ropeMethod))
      .filter((label) => label !== null),
  );
  return labels.size === 0 ? null : [...labels].join(" · ");
}

export function formatClimbingGradeComponents(components: readonly GradeComponent[]): string {
  return components
    .map(
      (grade) =>
        `${grade.value} (${grade.system === null ? "Scale unknown" : gradeSystemLabel(grade.system)})`,
    )
    .join(" · ");
}
export function formatGpsCoordinates(coordinates: GpsCoordinates): string {
  return [coordinates.latitude, coordinates.longitude]
    .map((value) => String(value).replace(/^-/, "−"))
    .join(", ");
}
const yesNoUnknown = (value: boolean | null) => (value === null ? "Unknown" : value ? "Yes" : "No");

/** Display recorded facts; outcome and rock-result inference belong to the server. */
export function climbingAttemptDetailFields(
  attempt: ClimbingAttempt,
): Array<{ label: string; value: string }> {
  return [
    { label: "Scope", value: attempt.scope === "climb" ? "Whole climb" : "Pitch" },
    {
      label: "Outcome",
      value:
        attempt.outcome === null
          ? "Not reported by source"
          : attempt.outcome === "completed"
            ? "Completed"
            : "Failed",
    },
    {
      label: "Attempt order",
      value: attempt.attemptIndex === null ? "Unknown" : String(attempt.attemptIndex),
    },
    { label: "Rope method", value: formatClimbingRopeMethod(attempt.ropeMethod) ?? "Unknown" },
    { label: "Solo", value: yesNoUnknown(attempt.solo) },
    {
      label: "Protection used",
      value:
        attempt.protectionUsed === null
          ? "Unknown"
          : attempt.protectionUsed
              .map((value) => (value === "sport" ? "Sport" : "Trad"))
              .join(", ") || "None recorded",
    },
    { label: "Used preplaced protection", value: yesNoUnknown(attempt.usedPreplacedProtection) },
    { label: "Used aid", value: yesNoUnknown(attempt.usedAid) },
    { label: "Fell or hung", value: yesNoUnknown(attempt.fellOrHung) },
    { label: "Dabbed", value: yesNoUnknown(attempt.dabbed) },
    { label: "Received beta", value: yesNoUnknown(attempt.receivedBeta) },
    { label: "Had completed before", value: yesNoUnknown(attempt.hadCompletedBefore) },
    {
      label: "Prior failed attempts from the ground",
      value: yesNoUnknown(attempt.priorFailedAttemptsGroundUp),
    },
    {
      label: "Pitch reference",
      value: attempt.pitchId ?? (attempt.scope === "pitch" ? "Unidentified" : "None"),
    },
    { label: "Parent attempt reference", value: attempt.parentAttemptId ?? "None" },
  ];
}
