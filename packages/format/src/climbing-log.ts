import { gradeSystemLabel } from "@dofek/training/climbing-grades";
import type { AttemptOutcome, ClimbingAttempt, GradeComponent } from "@dofek/training/climbing-log";
import { formatClimbingRopeMethod } from "./climbing-context.ts";

export function formatClimbingResultOutcome(
  outcome: AttemptOutcome | null,
  resultLabels: readonly string[] = [],
  freeSend: boolean | null = null,
): "Attempted" | "Completed" | null {
  if (outcome === "failed") return "Attempted";
  if (outcome === "completed" && freeSend !== true && resultLabels.length === 0) return "Completed";
  return null;
}

export function formatClimbingRecordedResult(
  target: string | null,
  outcome: AttemptOutcome | null,
  recordedCount: number | null,
  resultLabels: readonly string[] = [],
  freeSend: boolean | null = null,
): string | null {
  const result = formatClimbingResultOutcome(outcome, resultLabels, freeSend);
  return (
    [
      target,
      result,
      recordedCount === null || isFirstTryClimbingResult(resultLabels)
        ? null
        : `Attempts: ${recordedCount}`,
    ]
      .filter((part) => part !== null)
      .join(" · ") || null
  );
}

export function isFirstTryClimbingResult(labels: readonly string[]): boolean {
  return labels.some((label) => label === "Onsight" || label === "Flash");
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
const yesNo = (value: boolean | null) => (value === null ? null : value ? "Yes" : "No");

/** Display recorded facts; outcome and rock-result inference belong to the server. */
export function climbingAttemptDetailFields(
  attempt: ClimbingAttempt,
): Array<{ label: string; value: string }> {
  const fields = [
    {
      label: "Outcome",
      value:
        attempt.outcome === null ? null : attempt.outcome === "completed" ? "Completed" : "Failed",
    },
    { label: "Rope method", value: formatClimbingRopeMethod(attempt.ropeMethod) },
    { label: "Solo", value: yesNo(attempt.solo) },
    {
      label: "Protection used",
      value:
        attempt.protectionUsed?.map((value) => (value === "sport" ? "Sport" : "Trad")).join(", ") ||
        null,
    },
    { label: "Used preplaced protection", value: yesNo(attempt.usedPreplacedProtection) },
    { label: "Used aid", value: yesNo(attempt.usedAid) },
    { label: "Fell or hung", value: yesNo(attempt.fellOrHung) },
    { label: "Dabbed", value: yesNo(attempt.dabbed) },
    { label: "Received beta", value: yesNo(attempt.receivedBeta) },
    { label: "Had completed before", value: yesNo(attempt.hadCompletedBefore) },
    {
      label: "Prior failed attempts from the ground",
      value: yesNo(attempt.priorFailedAttemptsGroundUp),
    },
  ];
  return fields.filter((field): field is { label: string; value: string } => field.value !== null);
}
