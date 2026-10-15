import type { ClimbingAttempt, ClimbKind } from "@dofek/training/climbing-log";

export type SourceAttemptFacts = Partial<
  Pick<
    ClimbingAttempt,
    | "attemptIndex"
    | "outcome"
    | "ropeMethod"
    | "solo"
    | "protectionUsed"
    | "usedPreplacedProtection"
    | "usedAid"
    | "fellOrHung"
    | "dabbed"
    | "receivedBeta"
    | "hadCompletedBefore"
    | "priorFailedAttemptsGroundUp"
    | "notes"
  >
>;

export type SourceAttemptQualifier =
  | "free-onsight"
  | "free-flash"
  | "free-send"
  | "fell-hung"
  | "aid-onsight"
  | "aid-flash"
  | "dab";

/** Source qualifiers describe one try. They establish no facts about other tries. */
export function normalizeSourceAttemptFacts(
  supplied: SourceAttemptFacts,
  qualifier: SourceAttemptQualifier | undefined,
  context: {
    climbKind: ClimbKind | null;
    targetIdentified: boolean;
    hasOtherTargetHistory: boolean;
  },
): SourceAttemptFacts {
  const inferred: SourceAttemptFacts = {};
  const free =
    qualifier === "free-onsight" || qualifier === "free-flash" || qualifier === "free-send";
  const aid = qualifier === "aid-onsight" || qualifier === "aid-flash";
  const onsight = qualifier === "free-onsight" || qualifier === "aid-onsight";
  const flash = qualifier === "free-flash" || qualifier === "aid-flash";
  if (free || aid || qualifier === "dab") {
    inferred.outcome = "completed";
  }
  if (free) {
    inferred.fellOrHung = false;
    inferred.usedAid = false;
    if (context.climbKind === "boulder") inferred.dabbed = false;
  }
  if (aid) inferred.usedAid = true;
  if ((onsight || flash) && context.targetIdentified) inferred.attemptIndex = 1;
  if (onsight) inferred.receivedBeta = false;
  if (flash && context.targetIdentified && !context.hasOtherTargetHistory)
    inferred.receivedBeta = true;
  if (qualifier === "fell-hung") inferred.fellOrHung = true;
  if (qualifier === "dab") inferred.dabbed = true;

  for (const key of [
    "attemptIndex",
    "outcome",
    "fellOrHung",
    "usedAid",
    "dabbed",
    "receivedBeta",
  ] as const) {
    if (inferred[key] != null && supplied[key] != null && supplied[key] !== inferred[key]) {
      throw new Error(`Source ${qualifier} qualifier conflicts with the recorded ${key} fact.`);
    }
  }
  return { ...supplied, ...inferred };
}
