import { gradeSystemLabel } from "@dofek/training/climbing-grades";
import type { AttemptOutcome, ClimbingAttempt, GradeComponent } from "@dofek/training/climbing-log";
import type { ClimbingProjectHistory } from "@dofek/training/climbing-project-history";
import { formatClimbingRopeMethod } from "./climbing-context.ts";
import { formatDateShort } from "./format.ts";

function sessionNoun(count: number) {
  return count === 1 ? "session" : "sessions";
}

export function formatClimbingProjectHistory(history: ClimbingProjectHistory) {
  const { firstSend, methodFirstSend, repeatBeforeFirstSend } = history;
  const distinctMethodSend =
    methodFirstSend &&
    (!firstSend ||
      methodFirstSend.date !== firstSend.date ||
      methodFirstSend.sessionCount !== firstSend.sessionCount ||
      methodFirstSend.method !== firstSend.method);
  const shortDate = (date: string) => formatDateShort(date, { timeZone: "UTC" });
  const firstSendDetails = firstSend
    ? [
        formatClimbingRopeMethod(firstSend.method),
        shortDate(firstSend.date),
        history.earlierSessionsUnknown ? "Earlier sessions unknown" : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  const methodLabel = distinctMethodSend
    ? formatClimbingRopeMethod(methodFirstSend.method)?.toLowerCase()
    : null;
  return {
    summary: firstSend
      ? `${firstSend.sessionCount} logged ${sessionNoun(firstSend.sessionCount)} to first recorded send`
      : `${history.sessionCount} logged ${sessionNoun(history.sessionCount)} · ${repeatBeforeFirstSend ? "First send date unknown" : "Send unconfirmed"}`,
    detail:
      firstSendDetails ??
      [
        `${history.unsuccessfulSessionCount} unsuccessful`,
        `${history.unknownSessionCount} ${history.unknownSessionCount === 1 ? "result" : "results"} unknown`,
      ].join(" · "),
    methodDetail:
      methodFirstSend && methodLabel
        ? `First recorded ${methodLabel} send after ${methodFirstSend.sessionCount} ${methodLabel} ${sessionNoun(methodFirstSend.sessionCount)} · ${shortDate(methodFirstSend.date)}`
        : null,
  };
}

const projectOutcomes = {
  send: "Sent",
  unsuccessful: "Unsuccessful",
  unknown: "Result unknown",
} as const;

export function formatClimbingProjectDay(day: ClimbingProjectHistory["days"][number]): string {
  const method = formatClimbingRopeMethod(day.method);
  return [method, projectOutcomes[day.outcome]].filter(Boolean).join(" · ");
}

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

export function climbingAttemptStyleLabels(
  attempts: readonly Pick<ClimbingAttempt, "ropeMethod" | "fellOrHung">[],
): string[][] {
  const styles = new Map<string, string[]>();
  for (const attempt of attempts) {
    const labels = [
      formatClimbingRopeMethod(attempt.ropeMethod),
      attempt.fellOrHung === true ? "Fell/Hung" : null,
    ].filter((label) => label !== null);
    if (labels.length > 0) styles.set(labels.join(":"), labels);
  }
  return [...styles.values()];
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
