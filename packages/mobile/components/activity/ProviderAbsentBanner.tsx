import { formatDateTime } from "@dofek/format/format";
import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { providerAbsentExplanation, providerSourceLabel } from "@dofek/providers/providers";
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
  const restore = trpc.activity.restoreProviderAbsent.useMutation({
    onSuccess: async () => {
      await Promise.all([
        trpcUtils.activity.invalidate(),
        trpcUtils.calendar.weekListV2.invalidate(),
        trpcUtils.calendar.activityOverview.invalidate(),
        trpcUtils.calendar.calendarData.invalidate(),
      ]);
    },
    onError: (error) => captureException(error, { source: "activity-restore" }),
  });

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
        accessibilityState={{ disabled: restore.isPending }}
        disabled={restore.isPending}
        onPress={() => {
          restore.reset();
          restore.mutate({ ids: [activity.id] });
        }}
        style={[
          styles.providerAbsentRestoreButton,
          restore.isPending && styles.recomputeButtonDisabled,
        ]}
      >
        <Text style={styles.providerAbsentRestoreButtonText}>
          {restore.isPending ? "Restoring…" : "Restore activity"}
        </Text>
      </Pressable>
      {restore.error && (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {userFacingErrorMessage(restore.error, "Unable to restore this activity.")}
        </Text>
      )}
    </View>
  );
}
