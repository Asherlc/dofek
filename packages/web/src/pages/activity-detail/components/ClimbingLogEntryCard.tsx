import {
  formatClimbingRecordedResult,
  formatClimbingRopeMethods,
} from "@dofek/format/climbing-log";
import type { ClimbingMapLocation, ClimbingMapMarker } from "@dofek/training/climbing-map";
import { useMemo } from "react";
import type { ClimbingLogEntryDetail } from "../../../../../server/src/contracts/climbing-log-contracts.ts";
import { ActivityRouteMap } from "../../../components/ActivityRouteMap.tsx";
import { ClimbingLogEntryContext } from "./ClimbingLogEntryContext.tsx";
import { ClimbingLogEntrySources } from "./ClimbingLogEntrySources.tsx";

const NO_SENSOR_POINTS: { lat: number; lng: number }[] = [];

export interface ClimbingLogAttachmentState {
  pending: boolean;
  error: string | null;
}

export function ClimbingLogEntryCard({
  entry,
  location,
  entryNumber,
  selected = false,
  attachmentState,
  onAttach,
}: {
  entry: ClimbingLogEntryDetail;
  location?: ClimbingMapLocation;
  entryNumber?: number;
  selected?: boolean;
  attachmentState?: ClimbingLogAttachmentState;
  onAttach?: (entryId: string) => void;
}) {
  const name = entry.climb?.name ?? entry.title ?? "Climbing log";
  const methods = formatClimbingRopeMethods(entry.attempts);
  const markers = useMemo<ClimbingMapMarker[]>(
    () => (location ? [{ entryId: entry.id, entryNumber, label: name, location }] : []),
    [entry.id, entryNumber, name, location],
  );
  return (
    <li
      aria-current={selected ? "true" : undefined}
      className={`flex min-w-0 flex-col gap-3 rounded-lg border p-3 ${selected ? "border-accent" : "border-border"}`}
    >
      {location && (
        <ActivityRouteMap points={NO_SENSOR_POINTS} climbMarkers={markers} presentation="compact" />
      )}
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
        {methods && <p>{methods}</p>}
        {entry.recordedClimbAttemptCount > 0 && (
          <p>
            {formatClimbingRecordedResult(
              null,
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
      {onAttach && (
        <div className="mt-auto space-y-2">
          {attachmentState?.error && (
            <p role="alert" className="text-sm text-red-400">
              {attachmentState.error}
            </p>
          )}
          <button
            type="button"
            className="self-start rounded bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
            aria-label={`Attach ${entryNumber == null ? name : `entry ${entryNumber}, ${name}`} to this activity`}
            aria-busy={attachmentState?.pending ?? false}
            disabled={attachmentState?.pending}
            onClick={() => onAttach(entry.id)}
          >
            {attachmentState?.pending ? "Attaching..." : "Attach"}
          </button>
        </div>
      )}
    </li>
  );
}
