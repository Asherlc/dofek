import { formatDateTime } from "@dofek/format/format";
import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { providerAbsentExplanation, providerSourceLabel } from "@dofek/providers/providers";
import { useCallback, useEffect, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { captureException } from "../../lib/telemetry";
import { trpc } from "../../lib/trpc";
import { styles } from "./styles";

interface ProviderAbsentBannerActivity {
  id: string;
  providerId: string;
  subsource?: string | null;
  providerAbsentAt: Date | string | null;
}

export function ProviderAbsentBanner({ activity }: { activity: ProviderAbsentBannerActivity }) {
  const trpcUtils = trpc.useUtils();
  const refreshActivityQueries = useCallback(async () => {
    await Promise.all([
      trpcUtils.activity.invalidate(),
      trpcUtils.calendar.weekListV2.invalidate(),
      trpcUtils.calendar.activityOverview.invalidate(),
      trpcUtils.calendar.calendarData.invalidate(),
    ]);
  }, [trpcUtils]);
  const restore = trpc.activity.restoreProviderAbsent.useMutation({
    onSuccess: refreshActivityQueries,
    onError: (error) => captureException(error, { source: "activity-restore" }),
  });

  const analyticsJobId = restore.data?.analyticsJobId;
  const refreshStatus = trpc.activity.restoreStatus.useQuery(
    { jobId: analyticsJobId ?? "" },
    {
      enabled: !!analyticsJobId,
      refetchInterval: (query) =>
        !query.state.error && query.state.data?.status === "pending" ? 2_000 : false,
    },
  );
  const completedJobId = useRef<string | null>(null);
  useEffect(() => {
    if (
      analyticsJobId &&
      refreshStatus.data?.status === "completed" &&
      completedJobId.current !== analyticsJobId
    ) {
      completedJobId.current = analyticsJobId;
      void refreshActivityQueries().catch((error: unknown) =>
        captureException(error, { source: "activity-restore-refresh" }),
      );
    }
  }, [analyticsJobId, refreshStatus.data?.status, refreshActivityQueries]);
  const isRefreshing =
    restore.isPending ||
    (!!analyticsJobId &&
      !refreshStatus.error &&
      refreshStatus.data?.status !== "completed" &&
      refreshStatus.data?.status !== "failed");
  const errorMessage = restore.error
    ? userFacingErrorMessage(restore.error, "Unable to restore this activity.")
    : refreshStatus.error
      ? userFacingErrorMessage(
          refreshStatus.error,
          "Restore refresh status is unavailable. Reload the activity to check its charts.",
        )
      : (refreshStatus.data?.error ?? restore.data?.analyticsError);

  if (!activity.providerAbsentAt) {
    return isRefreshing || errorMessage ? (
      <View style={styles.providerAbsentBanner}>
        {isRefreshing && (
          <Text accessibilityRole="status" style={styles.providerAbsentTitle}>
            Refreshing restored activity charts…
          </Text>
        )}
        {errorMessage && (
          <Text accessibilityRole="alert" style={styles.errorText}>
            {errorMessage}
          </Text>
        )}
      </View>
    ) : null;
  }

  return (
    <View style={styles.providerAbsentBanner}>
      <Text style={styles.providerAbsentTitle}>Removed from provider sync</Text>
      <View style={styles.providerAbsentDetails}>
        <View style={styles.providerAbsentDetail}>
          <Text style={styles.providerAbsentLabel}>Status</Text>
          <Text style={styles.providerAbsentValue}>Removed</Text>
        </View>
        <View style={styles.providerAbsentDetail}>
          <Text style={styles.providerAbsentLabel}>Provider</Text>
          <Text style={styles.providerAbsentValue}>
            {providerSourceLabel(activity.providerId, activity.subsource)}
          </Text>
        </View>
        <View style={styles.providerAbsentDetail}>
          <Text style={styles.providerAbsentLabel}>Removed at</Text>
          <Text style={styles.providerAbsentValue}>
            {activity.providerAbsentAt ? formatDateTime(activity.providerAbsentAt) : "—"}
          </Text>
        </View>
      </View>
      <Text style={styles.providerAbsentExplanation}>
        {providerAbsentExplanation(activity.providerId, activity.subsource)}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: isRefreshing }}
        disabled={isRefreshing}
        onPress={() => {
          restore.reset();
          restore.mutate({ ids: [activity.id] });
        }}
        style={[styles.providerAbsentRestoreButton, isRefreshing && styles.recomputeButtonDisabled]}
      >
        <Text style={styles.providerAbsentRestoreButtonText}>
          {isRefreshing ? "Restoring…" : "Restore activity"}
        </Text>
      </Pressable>
      {errorMessage && (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {errorMessage}
        </Text>
      )}
    </View>
  );
}
