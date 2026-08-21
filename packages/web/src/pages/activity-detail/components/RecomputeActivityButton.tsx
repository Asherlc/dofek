import { useState } from "react";
import { locallyReportedErrorMeta } from "../../../lib/query-client.ts";
import { captureException } from "../../../lib/telemetry.ts";
import { trpc } from "../../../lib/trpc.ts";

export function RecomputeActivityButton({ activityId }: { activityId: string }) {
  const [isRecomputing, setIsRecomputing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const trpcUtils = trpc.useUtils();
  const recomputeMutation = trpc.activity.recompute.useMutation({
    meta: locallyReportedErrorMeta,
    onSuccess: async () => {
      setErrorMessage(null);
      setIsRecomputing(true);
      try {
        await Promise.all([
          trpcUtils.activity.byId.invalidate({ id: activityId }),
          trpcUtils.activity.stream.invalidate({ id: activityId, maxPoints: 500 }),
          trpcUtils.activity.hrZones.invalidate({ id: activityId }),
          trpcUtils.activity.powerZones.invalidate({ id: activityId }),
          trpcUtils.activity.strengthExercises.invalidate({ id: activityId }),
          trpcUtils.activity.list.invalidate(),
          trpcUtils.calendar.weekList.invalidate(),
          trpcUtils.calendar.activityOverview.invalidate(),
        ]);
      } finally {
        setIsRecomputing(false);
      }
    },
    onError: (error) => {
      setIsRecomputing(false);
      captureException(error, { context: "activity-recompute" });
      setErrorMessage(error instanceof Error ? error.message : "Unable to recompute activity.");
    },
  });

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => recomputeMutation.mutate({ id: activityId })}
        disabled={recomputeMutation.isPending || isRecomputing}
        className="px-3 py-1.5 text-xs rounded bg-accent/10 text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors cursor-pointer"
      >
        {recomputeMutation.isPending || isRecomputing ? "Recomputing..." : "Recompute"}
      </button>
      {errorMessage ? <p className="text-xs text-red-400">{errorMessage}</p> : null}
    </div>
  );
}
