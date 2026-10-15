import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import type { ClimbingLogEntryDetail } from "../../../../../server/src/contracts/climbing-log-contracts.ts";
import { ClimbingLogEntryBreakdown } from "./ClimbingLogEntryBreakdown.tsx";
import type { ClimbingLogAttachmentState } from "./ClimbingLogEntryCard.tsx";

export type LogEntryAttachState = Record<string, ClimbingLogAttachmentState>;
export function UnattachedClimbingLogEntries({
  suggestions,
  locations,
  selectedEntryId,
  error,
  isLoading,
  state,
  onAttach,
}: {
  suggestions: readonly ClimbingLogEntryDetail[] | undefined;
  locations?: Readonly<Record<string, ClimbingMapLocation>>;
  selectedEntryId?: string | null;
  error: unknown | null;
  isLoading: boolean;
  state: LogEntryAttachState;
  onAttach: (climbingLogEntryId: string) => void;
}) {
  return (
    <div>
      {Boolean(error) && (
        <p role="alert" className="mb-2 text-sm text-red-400">
          {userFacingErrorMessage(error)}
        </p>
      )}
      {suggestions === undefined && isLoading ? (
        <p className="text-sm text-muted">Loading climbing logs...</p>
      ) : suggestions === undefined && error ? null : !suggestions?.length ? (
        <p className="text-sm text-muted">No unattached climbing logs for this day.</p>
      ) : (
        <>
          <h3 className="text-xs font-medium text-muted">Unattached</h3>
          <ClimbingLogEntryBreakdown
            entries={suggestions}
            locations={locations}
            selectedEntryId={selectedEntryId}
            attachmentStates={state}
            onAttach={onAttach}
            label="Unattached climbing logs"
          />
        </>
      )}
    </div>
  );
}
