import type { RopeMethod } from "@dofek/training/climbing-log";
import type { ClimbingProjectHistory } from "@dofek/training/climbing-project-history";

type ProjectDay = ClimbingProjectHistory["days"][number];

export interface ClimbingProjectObservation extends ProjectDay {
  repeat: boolean;
  earlierAttempts: boolean;
  described: boolean;
  selected: boolean;
}

interface DayEvidence {
  day: ProjectDay;
  allSendsAreRepeats: boolean;
  earlierAttempts: boolean;
}

function singleMethod(observations: readonly ClimbingProjectObservation[]): RopeMethod | null {
  const methods = new Set(observations.map((observation) => observation.method));
  return methods.size === 1 ? (methods.values().next().value ?? null) : null;
}

function collapseProjectDays(observations: readonly ClimbingProjectObservation[]): DayEvidence[] {
  const byDate = new Map<string, ClimbingProjectObservation[]>();
  for (const observation of observations) {
    const day = byDate.get(observation.date);
    if (day) day.push(observation);
    else byDate.set(observation.date, [observation]);
  }
  return [...byDate]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([date, recorded]) => {
      const sends = recorded.filter(({ outcome }) => outcome === "send");
      const unsuccessful = recorded.filter(({ outcome }) => outcome === "unsuccessful");
      const ambiguous = recorded.some(
        ({ outcome, described }) => outcome === "unknown" && described,
      );
      const outcome = sends.length
        ? "send"
        : unsuccessful.length && !ambiguous
          ? "unsuccessful"
          : "unknown";
      return {
        day: {
          date,
          outcome,
          method: singleMethod(
            sends.length ? sends : recorded.filter(({ described }) => described),
          ),
        },
        allSendsAreRepeats: sends.length > 0 && sends.every(({ repeat }) => repeat),
        earlierAttempts: sends.some(({ earlierAttempts }) => earlierAttempts),
      };
    });
}

function firstMilestone(days: readonly DayEvidence[]): ClimbingProjectHistory["firstSend"] {
  const firstIndex = days.findIndex(({ day }) => day.outcome === "send");
  const first = days[firstIndex];
  if (!first || first.allSendsAreRepeats) return null;
  return { date: first.day.date, method: first.day.method, sessionCount: firstIndex + 1 };
}

export function summarizeClimbingProjectHistory(
  throughDate: string,
  observations: readonly ClimbingProjectObservation[],
): ClimbingProjectHistory {
  const collapsed = collapseProjectDays(observations);
  const days = collapsed.map(({ day }) => day);
  const firstSend = firstMilestone(collapsed);
  const method = singleMethod(
    observations.filter(
      ({ selected, described, method }) => selected && (described || method !== null),
    ),
  );
  const methodMilestone = method
    ? firstMilestone(
        collapseProjectDays(observations.filter((observation) => observation.method === method)),
      )
    : null;
  return {
    throughDate,
    days,
    sessionCount: days.length,
    unsuccessfulSessionCount: days.filter(({ outcome }) => outcome === "unsuccessful").length,
    unknownSessionCount: days.filter(({ outcome }) => outcome === "unknown").length,
    firstSend,
    methodFirstSend: method && methodMilestone ? { ...methodMilestone, method } : null,
    repeatBeforeFirstSend:
      collapsed.find(({ day }) => day.outcome === "send")?.allSendsAreRepeats ?? false,
    earlierSessionsUnknown:
      firstSend?.sessionCount === 1 && (collapsed[0]?.earlierAttempts ?? false),
  };
}
