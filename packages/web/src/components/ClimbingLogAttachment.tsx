import { providerSourceLabel } from "@dofek/providers/providers";
import type { ClimbingLocationMapEntry } from "@dofek/training/climbing-location-map";
import { useEffect, useId, useRef, useState } from "react";
import { locallyReportedErrorMeta } from "../lib/query-client.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";
import { ModalDialog, ModalDialogDescription, ModalDialogTitle } from "./ModalDialog.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

export function ClimbingLogAttachment({
  entry,
  onClose,
}: {
  entry: Pick<ClimbingLocationMapEntry, "id" | "label" | "date">;
  onClose: () => void;
}) {
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  const radioName = useId();
  const activities = trpc.climbing.attachmentActivities.useQuery(
    { date: entry.date },
    { meta: locallyReportedErrorMeta },
  );
  const utils = trpc.useUtils();
  const attachment = trpc.climbing.attachClimbingLogEntry.useMutation({
    meta: locallyReportedErrorMeta,
    onSuccess: async (_result, input) => {
      await Promise.all([
        utils.climbing.locationMap.invalidate(),
        utils.climbing.activityLogEntries.invalidate(),
        utils.climbing.unattachedClimbingLogEntries.invalidate(),
        utils.climbing.sessionSummary.invalidate(),
        utils.climbing.gradeProgressionV2.invalidate(),
        utils.climbing.volumeByGrade.invalidate(),
        utils.climbing.strengths.invalidate(),
        utils.activity.images.invalidate({ id: input.activityId }),
        utils.activity.list.invalidate(),
        utils.calendar.weekList.invalidate(),
      ]);
      onClose();
    },
    onError: (error) => captureException(error, { component: "ClimbingLogAttachment" }),
  });
  const canAttach =
    !attachment.isPending &&
    activities.data?.some((activity) => activity.id === selectedActivityId);

  useEffect(() => {
    if (activities.error)
      captureException(activities.error, { component: "ClimbingLogAttachment" });
  }, [activities.error]);

  return (
    <ModalDialog
      open
      onClose={onClose}
      ariaDescribedBy={descriptionId}
      initialFocusRef={cancelRef}
      closeOnEscape={!attachment.isPending}
      contentClassName="w-[calc(100%-2rem)] max-w-md max-h-[85vh] overflow-y-auto rounded-xl border border-border bg-surface-solid p-6 shadow-2xl"
    >
      <ModalDialogTitle className="text-lg font-semibold text-foreground">
        Attach {entry.label} to activity
      </ModalDialogTitle>
      <ModalDialogDescription id={descriptionId} className="mt-2 text-sm text-muted">
        Choose a recorded activity from <time dateTime={entry.date}>{entry.date}</time>.
      </ModalDialogDescription>
      <form
        aria-busy={attachment.isPending}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canAttach || selectedActivityId === null) return;
          attachment.mutate({ climbingLogEntryId: entry.id, activityId: selectedActivityId });
        }}
      >
        <div className="mt-4 space-y-3">
          {activities.error ? (
            <QueryStatePanel
              variant="error"
              contextLabel="Same-day activities"
              error={activities.error}
              height={100}
              onRetry={() => void activities.refetch()}
              retrying={activities.isFetching}
            />
          ) : null}
          {activities.data === undefined && activities.isLoading ? (
            <QueryStatePanel
              variant="loading"
              message="Loading same-day activities…"
              height={100}
            />
          ) : null}
          {!activities.error && activities.data?.length === 0 ? (
            <QueryStatePanel
              variant="empty"
              message="No climbing or hiking activities recorded on this day."
              height={100}
            />
          ) : null}
          {activities.data && activities.data.length > 0 ? (
            <fieldset disabled={attachment.isPending} className="space-y-2">
              <legend className="sr-only">Same-day recorded activity</legend>
              {activities.data.map((activity) => {
                const type = activity.activityType === "climbing" ? "Climbing" : "Hiking";
                const recordedName = activity.name?.trim();
                const details = recordedName
                  ? [activity.startTime, type, providerSourceLabel(activity.providerId)]
                  : [activity.startTime, providerSourceLabel(activity.providerId)];
                return (
                  <label
                    key={activity.id}
                    className="flex items-center gap-3 rounded-lg border border-border p-3 text-sm"
                  >
                    <input
                      type="radio"
                      name={radioName}
                      value={activity.id}
                      checked={selectedActivityId === activity.id}
                      onChange={() => setSelectedActivityId(activity.id)}
                      className="accent-accent"
                    />
                    <span className="min-w-0">
                      <span className="block font-medium">{recordedName || type}</span>{" "}
                      <span className="block text-xs text-muted">{details.join(" · ")}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          ) : null}
          {attachment.error ? (
            <QueryStatePanel
              variant="error"
              title="Could not attach climbing log"
              error={attachment.error}
              height={100}
            />
          ) : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            disabled={attachment.isPending}
            className="rounded px-3 py-2 text-sm text-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canAttach}
            className="rounded bg-accent px-3 py-2 text-sm text-on-accent disabled:opacity-50"
          >
            {attachment.isPending ? "Attaching…" : "Attach"}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
