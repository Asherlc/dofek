import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { buildClimbingMapLocations, buildClimbingMapMarkers } from "@dofek/training/climbing-map";
import { useMemo, useState } from "react";
import { decodeClimbingLogEntriesResponse } from "../../../server/src/contracts/climbing-log-contracts.ts";
import { trpc } from "../../lib/trpc";

export function useActivityClimbing(activityId: string | undefined, enabled: boolean) {
  const queryId = activityId ?? "";
  const entries = trpc.climbing.activityLogEntries.useQuery(
    { activityId: queryId, responseVersion: 5 },
    { enabled: !!activityId && enabled, select: decodeClimbingLogEntriesResponse },
  );
  const suggestions = trpc.climbing.unattachedClimbingLogEntries.useQuery(
    { activityId: queryId, responseVersion: 5 },
    { enabled: !!activityId && enabled, select: decodeClimbingLogEntriesResponse },
  );
  const selectedEntries = useMemo(
    () => [...(entries.data ?? []), ...(suggestions.data ?? [])],
    [entries.data, suggestions.data],
  );
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const selectedEntry = selectedEntries.find((entry) => entry.id === selectedEntryId);
  const locations = useMemo(() => buildClimbingMapLocations(selectedEntries), [selectedEntries]);
  const markers = useMemo(
    () => (enabled ? buildClimbingMapMarkers(selectedEntries) : []),
    [enabled, selectedEntries],
  );
  const [attachmentStates, setAttachmentStates] = useState<
    Record<string, { pending: boolean; error: string | null }>
  >({});
  const utils = trpc.useUtils();
  const attach = trpc.climbing.attachClimbingLogEntry.useMutation({
    onSuccess: async (_result, input) => {
      await Promise.all([
        utils.activity.images.invalidate({ id: input.activityId }),
        utils.climbing.activityLogEntries.invalidate({
          activityId: input.activityId,
          responseVersion: 5,
        }),
        utils.climbing.sessionSummary.invalidate(),
        utils.mobileDashboard.trainingV2.invalidate(),
        utils.climbing.volumeByGrade.invalidate(),
        utils.climbing.strengths.invalidate(),
        utils.climbing.unattachedClimbingLogEntries.invalidate({
          activityId: input.activityId,
          responseVersion: 5,
        }),
      ]);
    },
  });
  const attachEntry = (entryId: string) => {
    if (!activityId) return;
    setAttachmentStates((current) => ({ ...current, [entryId]: { pending: true, error: null } }));
    attach.mutate(
      { activityId, climbingLogEntryId: entryId },
      {
        onSuccess: () =>
          setAttachmentStates((current) => ({
            ...current,
            [entryId]: { pending: false, error: null },
          })),
        onError: (error) =>
          setAttachmentStates((current) => ({
            ...current,
            [entryId]: { pending: false, error: userFacingErrorMessage(error) },
          })),
      },
    );
  };

  return {
    entries,
    suggestions,
    loading: entries.isLoading && !entries.data,
    selectedEntryId,
    setSelectedEntryId,
    selectedEntry,
    locations,
    markers,
    attachmentStates,
    attachEntry,
  };
}
