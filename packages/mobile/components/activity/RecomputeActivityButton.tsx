import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, Text } from "react-native";
import { captureException } from "../../lib/telemetry";
import { trpc } from "../../lib/trpc";
import { styles } from "./styles";

function showRecomputeFailure(message: string) {
  Alert.alert("Recompute Failed", message);
}

export function RecomputeActivityButton({ activityId }: { activityId: string }) {
  const [analyticsJobId, setAnalyticsJobId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const trpcUtils = trpc.useUtils();

  const refreshActivityQueries = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([
        trpcUtils.activity.byId.invalidate({ id: activityId }),
        trpcUtils.activity.stream.invalidate({ id: activityId, maxPoints: 200 }),
        trpcUtils.activity.heartRateContext.invalidate({ id: activityId }),
        trpcUtils.activity.hrZones.invalidate({ id: activityId }),
        trpcUtils.activity.powerZones.invalidate({ id: activityId }),
        trpcUtils.activity.powerWork.invalidate({ id: activityId }),
        trpcUtils.activity.strengthExercises.invalidate({ id: activityId }),
        trpcUtils.activity.hangboardDetails.invalidate({ id: activityId }),
        trpcUtils.activity.list.invalidate(),
        trpcUtils.calendar.weekListV2.invalidate(),
        trpcUtils.calendar.activityOverview.invalidate(),
      ]);
    } catch (error) {
      captureException(error, { source: "activity-recompute-refresh" });
    } finally {
      setIsRefreshing(false);
    }
  }, [activityId, trpcUtils]);

  const recomputeMutation = trpc.activity.recompute.useMutation({
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
      captureException(error, { source: "activity-recompute" });
      showRecomputeFailure(userFacingErrorMessage(error, "Unable to recompute activity."));
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
      showRecomputeFailure(
        userFacingErrorMessage(
          recomputeStatus.error,
          "Recompute status is unavailable. Reload the activity to check its metrics.",
        ),
      );
    } else if (recomputeStatus.data?.status === "failed") {
      setAnalyticsJobId(null);
      showRecomputeFailure(
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
    <Pressable
      onPress={() => recomputeMutation.mutate({ id: activityId })}
      disabled={isRecomputing}
      accessibilityRole="button"
      accessibilityLabel="Recompute activity"
      accessibilityState={{ busy: isRecomputing, disabled: isRecomputing }}
      style={({ pressed }) => [
        styles.recomputeButton,
        pressed && styles.recomputeButtonPressed,
        isRecomputing && styles.recomputeButtonDisabled,
      ]}
    >
      <Text style={styles.recomputeButtonText}>
        {isRecomputing ? "Recomputing..." : "Recompute"}
      </Text>
    </Pressable>
  );
}
