import { formatClimbingAttemptResult } from "@dofek/format/format";
import type { ClimbingActivityEntryRow } from "../../../../../server/src/repositories/climbing-repository.ts";
import { ClimbingEntryContext } from "./ClimbingEntryContext.tsx";

export function ClimbingEntryBreakdown({ entries }: { entries: ClimbingActivityEntryRow[] }) {
  return (
    <div className="divide-y divide-border">
      {entries.map((entry) => {
        const attemptResult = formatClimbingAttemptResult(
          entry.sent,
          entry.attemptCount,
          entry.ascentType,
        );
        return (
          <div
            key={entry.id}
            className="flex flex-wrap items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className="min-w-12 rounded bg-accent/10 px-2 py-1 text-center text-sm font-semibold text-accent">
                {entry.grade}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {entry.routeName ?? (entry.climbType === "boulder" ? "Boulder" : "Route")}
                </p>
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
            <div className="shrink-0 text-right">
              {attemptResult !== null && (
                <p className={entry.sent ? "text-sm text-green-500" : "text-sm text-subtle"}>
                  {attemptResult}
                </p>
              )}
              <p className="text-xs text-dim">{entry.sourceName}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
