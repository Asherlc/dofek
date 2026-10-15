import { formatClimbingRecordedResult } from "@dofek/format/climbing-log";
import { useId, useState } from "react";
import type { ClimbingLogEntryDetail } from "../../../../../server/src/contracts/climbing-log-contracts.ts";
import { ClimbingLogEntryDetails } from "../../../components/ClimbingLogEntryDetails.tsx";
import { ClimbingLogEntryContext } from "./ClimbingLogEntryContext.tsx";
import { ClimbingLogEntrySources } from "./ClimbingLogEntrySources.tsx";

export function ClimbingLogEntryBreakdown({ entries }: { entries: ClimbingLogEntryDetail[] }) {
  return (
    <div className="divide-y divide-border">
      {entries.map((entry) => (
        <ClimbingLogCard key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
function ClimbingLogCard({ entry }: { entry: ClimbingLogEntryDetail }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const name = entry.climb?.name ?? entry.title ?? "Climbing log";
  return (
    <article className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <ClimbingLogEntrySources
            name={name}
            sourceName={entry.sourceName}
            links={entry.sourceLinks}
          />
          <ClimbingLogEntryContext entry={entry} />
        </div>
        {entry.displayGrade && (
          <span className="rounded bg-accent/10 px-2 py-1 text-sm font-semibold text-accent">
            {entry.displayGrade}
          </span>
        )}
      </div>
      <div className="space-y-1 text-xs text-subtle">
        {entry.recordedClimbAttemptCount > 0 && (
          <p>
            {formatClimbingRecordedResult(
              "Whole climb",
              entry.recordedClimbOutcome,
              entry.recordedClimbAttemptCount,
            )}
          </p>
        )}
        {entry.pitchResults.map((result) => (
          <p key={result.attemptIds.join(":")}>
            {formatClimbingRecordedResult(
              result.pitch === null
                ? "Unidentified pitch"
                : result.pitch.number === null
                  ? (result.pitch.name ?? "Pitch")
                  : `Pitch ${result.pitch.number}`,
              result.recordedOutcome,
              result.recordedAttemptCount,
            )}
          </p>
        ))}
        {entry.attempts.map(
          (attempt) =>
            attempt.rockResultLabels.length > 0 && (
              <p key={attempt.id} className="text-green-500">
                {attempt.rockResultLabels
                  .filter((label) => label !== "sent" || attempt.rockResultLabels.length === 1)
                  .map((label) => (label === "sent" ? "Sent" : label))
                  .join(" · ")}
              </p>
            ),
        )}
      </div>
      <button
        type="button"
        className="text-xs text-accent"
        aria-label={`Details for ${name}`}
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen(!open)}
      >
        {open ? "Hide details" : "Details"}
      </button>
      {open && (
        <div id={detailId} className="pt-2">
          <ClimbingLogEntryDetails entry={entry} />
        </div>
      )}
    </article>
  );
}
