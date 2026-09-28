import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import type { MountainProjectTickSuggestion } from "../../../../../server/src/repositories/mountain-project-tick-repository.ts";
import { ChartDescriptionTooltip } from "../../../components/ChartDescriptionTooltip.tsx";

export type TickAttachState = Record<string, { pending: boolean; error: string | null }>;

export function UnattachedMountainProjectTicks({
  suggestions,
  error,
  isLoading,
  state,
  onAttach,
}: {
  suggestions: MountainProjectTickSuggestion[] | undefined;
  error: unknown | null;
  isLoading: boolean;
  state: TickAttachState;
  onAttach: (tickId: string) => void;
}) {
  const title = "Unattached Mountain Project ticks";
  const description = "Ticks recorded for this day that can be attached to this climbing activity.";

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
          <p className="text-sm text-muted">Loading Mountain Project ticks...</p>
        ) : (suggestions?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted">No unattached Mountain Project ticks for this day.</p>
        ) : (
          <div className="space-y-3">
            {suggestions?.map((tick) => {
              const tickState = state[tick.id];
              const result =
                tick.sent === true ? "Sent" : tick.sent === false ? "Attempted" : "Status unknown";
              return (
                <div
                  key={tick.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border p-3"
                >
                  <div>
                    <p className="font-medium">
                      {tick.routeName ?? (tick.climbType === "boulder" ? "Boulder" : "Route")}
                    </p>
                    <p className="text-sm text-muted">
                      {[
                        tick.grade,
                        result,
                        tick.attemptCount === null
                          ? null
                          : `${tick.attemptCount} ${tick.attemptCount === 1 ? "attempt" : "attempts"}`,
                        tick.locationName,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {tick.ascentType && <p className="text-sm text-green-500">{tick.ascentType}</p>}
                    {tickState?.error ? (
                      <p role="alert" className="text-sm text-red-400">
                        {tickState.error}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                    aria-label="Attach to this activity"
                    disabled={tickState?.pending}
                    onClick={() => onAttach(tick.id)}
                  >
                    {tickState?.pending ? "Attaching..." : "Attach"}
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
