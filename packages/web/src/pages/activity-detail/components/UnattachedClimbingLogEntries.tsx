import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import type { ClimbingLogEntryDetail } from "../../../../../server/src/contracts/climbing-log-contracts.ts";
import { ClimbingLogEntryBreakdown } from "./ClimbingLogEntryBreakdown.tsx";

export type LogEntryAttachState = Record<string, { pending: boolean; error: string | null }>;
export function UnattachedClimbingLogEntries({
  suggestions,
  error,
  isLoading,
  state,
  onAttach,
}: {
  suggestions: readonly ClimbingLogEntryDetail[] | undefined;
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
          <div className="divide-y divide-border">
            {suggestions.map((entry) => (
              <div key={entry.id} className="grid grid-cols-[1fr_auto] items-start gap-3">
                <ClimbingLogEntryBreakdown entries={[entry]} />
                <button
                  type="button"
                  className="mt-3 rounded bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  aria-label="Attach to this activity"
                  disabled={state[entry.id]?.pending}
                  onClick={() => onAttach(entry.id)}
                >
                  {state[entry.id]?.pending ? "Attaching..." : "Attach"}
                </button>
                {state[entry.id]?.error && (
                  <p role="alert" className="col-span-2 text-sm text-red-400">
                    {state[entry.id]?.error}
                  </p>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
