import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { providerSourceLabel } from "@dofek/providers/providers";
import type { ClimbingEntrySuggestion } from "../../../../../server/src/repositories/climbing-entry-associator.ts";
import { ChartDescriptionTooltip } from "../../../components/ChartDescriptionTooltip.tsx";

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
  const title = "Unattached climbing entries";
  const description =
    "Climbing entries recorded for this day that can be attached to this activity.";

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-medium text-muted uppercase tracking-wider">{title}</h2>
        <ChartDescriptionTooltip description={description} />
      </div>
      <div className="card p-4" title={description}>
        {error ? (
          <p className="text-sm text-red-400">{userFacingErrorMessage(error)}</p>
        ) : isLoading && !suggestions ? (
          <p className="text-sm text-muted">Loading climbing entries...</p>
        ) : (suggestions?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted">No unattached climbing entries for this day.</p>
        ) : (
          <div className="space-y-3">
            {suggestions?.map((entry) => {
              const entryState = state[entry.id];
              const result =
                entry.sent === true
                  ? "Sent"
                  : entry.sent === false
                    ? "Attempted"
                    : "Status unknown";
              return (
                <div
                  key={entry.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border p-3"
                >
                  <div>
                    <p className="font-medium">
                      {entry.routeName ?? (entry.climbType === "boulder" ? "Boulder" : "Route")}
                    </p>
                    <p className="text-xs text-subtle">
                      {entry.sourceName ?? providerSourceLabel(entry.providerId)}
                    </p>
                    <p className="text-sm text-muted">
                      {[
                        entry.grade,
                        result,
                        entry.attemptCount === null
                          ? null
                          : `${entry.attemptCount} ${entry.attemptCount === 1 ? "attempt" : "attempts"}`,
                        entry.locationName,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {entry.ascentType && (
                      <p className="text-sm text-green-500">{entry.ascentType}</p>
                    )}
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
        )}
      </div>
    </section>
  );
}
