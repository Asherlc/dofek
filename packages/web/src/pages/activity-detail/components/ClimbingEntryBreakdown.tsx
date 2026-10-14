import { formatClimbingAttemptResult } from "@dofek/format/format";
import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import type { ClimbingActivityEntryRow } from "../../../../../server/src/repositories/climbing-repository.ts";
import { ClimbingEntryCard } from "./ClimbingEntryCard.tsx";
import { ClimbingEntryContext } from "./ClimbingEntryContext.tsx";
import { ClimbingEntrySources } from "./ClimbingEntrySources.tsx";

export function ClimbingEntryBreakdown({
  entries,
  locations,
  selectedEntryId,
}: {
  entries: ClimbingActivityEntryRow[];
  locations?: Readonly<Record<string, ClimbingMapLocation>>;
  selectedEntryId?: string | null;
}) {
  return (
    <ul
      aria-label="Attached climbs"
      className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-3"
    >
      {entries.map((entry, index) => {
        const attemptResult = formatClimbingAttemptResult(
          entry.sent,
          entry.attemptCount,
          entry.ascentType,
          entry.context,
        );
        const location = locations?.[entry.id];
        const name = entry.routeName ?? (entry.climbType === "boulder" ? "Boulder" : "Route");
        return (
          <ClimbingEntryCard
            key={entry.id}
            entryId={entry.id}
            name={name}
            location={location}
            entryNumber={index + 1}
            selected={entry.id === selectedEntryId}
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className="min-w-12 rounded bg-accent/10 px-2 py-1 text-center text-sm font-semibold text-accent">
                {entry.grade}
              </span>
              <div className="min-w-0">
                <ClimbingEntrySources
                  name={name}
                  sourceName={entry.sourceName}
                  links={entry.sourceLinks}
                />
                <ClimbingEntryContext context={entry.context} sent={entry.sent} />
                {entry.holdType !== null && (
                  <p className="text-xs text-subtle">
                    {entry.holdType[0]?.toUpperCase()}
                    {entry.holdType.slice(1)}
                  </p>
                )}
                {entry.attempts.length > 0 && (
                  <ul className="mt-1 flex flex-wrap gap-1 text-xs text-subtle">
                    {entry.attempts.map((attempt) => (
                      <li className="rounded bg-surface px-2 py-0.5" key={attempt.attemptIndex}>
                        {attempt.attemptIndex}:{" "}
                        {attempt.outcome === "sent"
                          ? "Sent"
                          : `${attempt.failureReason?.[0]?.toUpperCase()}${attempt.failureReason?.slice(1)}`}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <div className="mt-auto">
              {attemptResult !== null && (
                <p className={entry.sent ? "text-sm text-green-500" : "text-sm text-subtle"}>
                  {attemptResult}
                </p>
              )}
            </div>
          </ClimbingEntryCard>
        );
      })}
    </ul>
  );
}
