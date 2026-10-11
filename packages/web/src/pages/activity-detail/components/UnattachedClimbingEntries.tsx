import { formatClimbingAttemptResult } from "@dofek/format/format";
import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { providerSourceLabel } from "@dofek/providers/providers";
import type { ClimbingEntrySuggestion } from "../../../../../server/src/repositories/climbing-entry-associator.ts";
import { ChartDescriptionTooltip } from "../../../components/ChartDescriptionTooltip.tsx";
import { ClimbingEntryContext } from "./ClimbingEntryContext.tsx";
import { ClimbingEntrySources } from "./ClimbingEntrySources.tsx";

export type EntryAttachState = Record<string, { pending: boolean; error: string | null }>;

export function UnattachedClimbingEntries({
  suggestions,
  error,
  isLoading,
  state,
  onAttach,
}: {
  suggestions: ClimbingEntrySuggestion[] | undefined;
  error: unknown | null;
  isLoading: boolean;
  state: EntryAttachState;
  onAttach: (entryId: string) => void;
}) {
  const description =
    "Climbing entries recorded for this day that can be attached to this activity.";

  return (
    <div>
      {error ? (
        <p className="text-sm text-red-400">{userFacingErrorMessage(error)}</p>
      ) : isLoading && !suggestions ? (
        <p className="text-sm text-muted">Loading climbing entries...</p>
      ) : (suggestions?.length ?? 0) === 0 ? (
        <p className="text-sm text-muted">No unattached climbing entries for this day.</p>
      ) : (
        <>
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-xs font-medium text-muted">Unattached</h3>
            <ChartDescriptionTooltip description={description} />
          </div>
          <div className="divide-y divide-border">
            {suggestions?.map((entry) => {
              const entryState = state[entry.id];
              const attemptResult = formatClimbingAttemptResult(
                entry.sent,
                entry.attemptCount,
                entry.ascentType,
                entry.context,
              );
              return (
                <div
                  key={entry.id}
                  className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0 flex-1">
                    <ClimbingEntrySources
                      name={
                        entry.routeName ?? (entry.climbType === "boulder" ? "Boulder" : "Route")
                      }
                      sourceName={entry.sourceName ?? providerSourceLabel(entry.providerId)}
                      links={entry.sourceLinks}
                    />
                    <p className="text-sm text-muted">
                      {entry.grade}
                      {attemptResult !== null ? ` · ${attemptResult}` : null}
                    </p>
                    <ClimbingEntryContext context={entry.context} sent={entry.sent} />
                    {entryState?.error ? (
                      <p role="alert" className="text-sm text-red-400">
                        {entryState.error}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                    aria-label="Attach to this activity"
                    disabled={entryState?.pending}
                    onClick={() => onAttach(entry.id)}
                  >
                    {entryState?.pending ? "Attaching..." : "Attach"}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
