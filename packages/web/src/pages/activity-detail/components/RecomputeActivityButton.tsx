import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { useCallback, useEffect, useState } from "react";
import { locallyReportedErrorMeta } from "../../../lib/query-client.ts";
import { captureException } from "../../../lib/telemetry.ts";
import { trpc } from "../../../lib/trpc.ts";

export function RecomputeActivityButton({ activityId }: { activityId: string }) {
  const [analyticsJobId, setAnalyticsJobId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const trpcUtils = trpc.useUtils();

  const refreshActivityQueries = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([
        trpcUtils.activity.byId.invalidate({ id: activityId }),
        trpcUtils.activity.stream.invalidate({ id: activityId, maxPoints: 500 }),
        trpcUtils.activity.heartRateContext.invalidate({ id: activityId }),
        trpcUtils.activity.hrZones.invalidate({ id: activityId }),
        trpcUtils.activity.powerZones.invalidate({ id: activityId }),
        trpcUtils.activity.powerWork.invalidate({ id: activityId }),
        trpcUtils.activity.strengthExercises.invalidate({ id: activityId }),
        trpcUtils.activity.list.invalidate(),
        trpcUtils.calendar.weekListV2.invalidate(),
        trpcUtils.calendar.activityOverview.invalidate(),
      ]);
    } catch (error) {
      captureException(error, { context: "activity-recompute-refresh" });
    } finally {
      setIsRefreshing(false);
    }
  }, [activityId, trpcUtils]);

  const recomputeMutation = trpc.activity.recompute.useMutation({
    meta: locallyReportedErrorMeta,
    onSuccess: async (result) => {
      if (!result.analyticsJobId) {
        await refreshActivityQueries();
        return;
      }
      // A later recompute of the same activity reuses the job id, so drop the
      // previous terminal status before polling again.
      await trpcUtils.activity.recomputeStatus.reset({ jobId: result.analyticsJobId });
      setAnalyticsJobId(result.analyticsJobId);
    },
    onError: (error) => {
      captureException(error, { context: "activity-recompute" });
      setErrorMessage(userFacingErrorMessage(error, "Unable to recompute activity."));
    },
  });

  const recomputeStatus = trpc.activity.recomputeStatus.useQuery(
    { jobId: analyticsJobId ?? "" },
    {
      enabled: analyticsJobId !== null,
      refetchInterval: (query) =>
        !query.state.error && query.state.data?.status === "pending" ? 2_000 : false,
    },
  );

  useEffect(() => {
    if (analyticsJobId === null) return;
    if (recomputeStatus.error) {
      setAnalyticsJobId(null);
      setErrorMessage(
        userFacingErrorMessage(
          recomputeStatus.error,
          "Recompute status is unavailable. Reload the activity to check its metrics.",
        ),
      );
    } else if (recomputeStatus.data?.status === "failed") {
      setAnalyticsJobId(null);
      setErrorMessage(
        recomputeStatus.data.error ??
          "Recomputing this activity failed. Use Recompute to try again.",
      );
    } else if (recomputeStatus.data?.status === "completed") {
      setAnalyticsJobId(null);
      void refreshActivityQueries();
    }
  }, [analyticsJobId, recomputeStatus.data, recomputeStatus.error, refreshActivityQueries]);

  const isRecomputing = recomputeMutation.isPending || analyticsJobId !== null || isRefreshing;

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => {
          setErrorMessage(null);
          recomputeMutation.mutate({ id: activityId });
        }}
        disabled={isRecomputing}
        aria-busy={isRecomputing}
        className="px-3 py-1.5 text-xs rounded bg-accent/10 text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors cursor-pointer"
      >
        {isRecomputing ? "Recomputing..." : "Recompute"}
      </button>
      {errorMessage ? (
        <p role="alert" className="text-xs text-red-400">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
