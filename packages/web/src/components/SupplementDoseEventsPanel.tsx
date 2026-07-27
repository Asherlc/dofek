import { formatDateTime } from "@dofek/format/format";
import {
  formatSupplementDoseStatus,
  type SupplementDoseOccurrence,
} from "@dofek/format/supplement-dose-events";
import { locallyReportedErrorMeta } from "../lib/query-client.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

export function SupplementDoseEventsPanel() {
  const utils = trpc.useUtils();
  const query = trpc.supplements.occurrences.useQuery({ days: 7 });
  const recordDose = trpc.supplements.recordDose.useMutation({
    onSuccess: (recorded) =>
      Promise.all([
        utils.supplements.occurrences.invalidate(),
        utils.food.byDateV2.invalidate({ date: recorded.scheduledDate }),
        utils.nutritionAnalytics.invalidate(),
      ]),
    onError: (error) => {
      captureException(error, { operation: "supplements.recordDose" });
    },
    meta: locallyReportedErrorMeta,
  });

  const hasCachedOccurrences = query.data !== undefined;
  if (query.isLoading && !hasCachedOccurrences) {
    return <QueryStatePanel variant="loading" height={96} />;
  }
  if (query.error && !hasCachedOccurrences) {
    return <QueryStatePanel error={query.error} height={96} />;
  }
  if (!query.data || query.data.occurrences.length === 0) {
    if (query.error) {
      return <QueryStatePanel error={query.error} height={96} />;
    }
    return (
      <QueryStatePanel
        variant="empty"
        height={96}
        message="No supplement dose occurrences in the last 7 days."
      />
    );
  }

  const { counts, occurrences } = query.data;
  return (
    <div className="space-y-3">
      {query.error ? <QueryStatePanel error={query.error} height={72} /> : null}
      <p className="text-xs text-muted">
        Taken {counts.taken} · Skipped {counts.skipped} · Unknown {counts.unknown} · Planned{" "}
        {counts.planned}
      </p>
      <ul className="divide-y divide-border">
        {occurrences.map((occurrence) => (
          <OccurrenceRow
            key={`${occurrence.scheduleId}:${occurrence.scheduledDate}`}
            occurrence={occurrence}
            disabled={recordDose.isPending}
            onRecord={(status) =>
              recordDose.mutate({
                expectedCurrentEventId: occurrence.currentEventId,
                status,
              })
            }
          />
        ))}
      </ul>
      {recordDose.isError ? (
        <p className="text-xs text-red-500">{recordDose.error.message}</p>
      ) : null}
    </div>
  );
}

function OccurrenceRow({
  occurrence,
  disabled,
  onRecord,
}: {
  occurrence: SupplementDoseOccurrence;
  disabled: boolean;
  onRecord: (status: "taken" | "skipped") => void;
}) {
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {occurrence.supplementName}
          </p>
          <p className="mt-1 text-xs text-muted">{occurrence.scheduledDate}</p>
          <p className="mt-1 text-xs text-subtle">
            {formatSupplementDoseStatus(occurrence.status)} · {occurrence.history.length}{" "}
            {occurrence.history.length === 1 ? "event" : "events"}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={disabled || occurrence.status === "taken"}
            onClick={() => onRecord("taken")}
            className="rounded border border-border-strong px-2 py-1 text-xs text-subtle disabled:opacity-50"
          >
            Taken
          </button>
          <button
            type="button"
            disabled={disabled || occurrence.status === "skipped"}
            onClick={() => onRecord("skipped")}
            className="rounded border border-border-strong px-2 py-1 text-xs text-subtle disabled:opacity-50"
          >
            Skip
          </button>
        </div>
      </div>
      <ul aria-label={`${occurrence.supplementName} history`} className="mt-2 space-y-1">
        {occurrence.history.map((event) => (
          <li key={event.id} className="text-xs text-muted">
            {formatSupplementDoseStatus(event.status)} · {event.sourceName ?? event.providerId} ·{" "}
            {formatDateTime(new Date(event.recordedAt))}
          </li>
        ))}
      </ul>
    </li>
  );
}
