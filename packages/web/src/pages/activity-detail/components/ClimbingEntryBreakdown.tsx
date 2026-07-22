import { formatClimbingAttemptResult } from "@dofek/format/format";
import type { ClimbingActivityEntryRow } from "../../../../../server/src/repositories/climbing-repository.ts";

export function ClimbingEntryBreakdown({ entries }: { entries: ClimbingActivityEntryRow[] }) {
  return (
    <div className="divide-y divide-border">
      {entries.map((entry) => (
        <div
          key={entry.id}
          className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
        >
          <div className="flex min-w-0 items-center gap-3">
            <span className="min-w-12 rounded bg-accent/10 px-2 py-1 text-center text-sm font-semibold text-accent">
              {entry.grade}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {entry.routeName ?? (entry.climbType === "boulder" ? "Boulder" : "Route")}
              </p>
              {entry.locationName && (
                <p className="truncate text-xs text-subtle">{entry.locationName}</p>
              )}
            </div>
          </div>
          <div className="shrink-0 text-right">
            {entry.ascentType && (
              <p className="text-sm font-medium text-green-500">{entry.ascentType}</p>
            )}
            <p className={entry.sent ? "text-sm text-green-500" : "text-sm text-subtle"}>
              {formatClimbingAttemptResult(entry.sent, entry.attemptCount)}
            </p>
            <p className="text-xs text-dim">{entry.sourceName}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
