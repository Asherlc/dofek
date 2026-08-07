import { useEffect, useRef } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import {
  ClimbingAttemptLog,
  type ClimbingSessionSubmission,
} from "../components/ClimbingAttemptLog";
import { FingerLoadingLog, type FingerLoadingSubmission } from "../components/FingerLoadingLog";
import { getQueryErrorMessage, QueryStatePanel } from "../components/QueryStatePanel";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { useUnitConverter } from "../lib/units";
import { colors, spacing } from "../theme";

export default function ClimbingLogScreen() {
  const units = useUnitConverter();
  const utils = trpc.useUtils();
  const history = trpc.climbing.fingerLoadingHistory.useQuery({ days: 90 });
  const lastHistoryError = useRef<unknown>(null);

  useEffect(() => {
    if (history.error && lastHistoryError.current !== history.error) {
      lastHistoryError.current = history.error;
      captureException(history.error, { context: "climbing-log-history" });
    }
  }, [history.error]);

  const fingerMutation = trpc.climbing.logFingerLoading.useMutation({
    meta: { errorReportedLocally: true },
    onError: (error) => captureException(error, { context: "climbing-finger-loading-log" }),
    onSuccess: async () => {
      await Promise.all([
        utils.climbing.fingerLoadingHistory.invalidate(),
        utils.mobileDashboard.training.invalidate(),
        utils.activity.invalidate(),
      ]);
    },
  });
  const climbingMutation = trpc.climbing.logClimbingSession.useMutation({
    meta: { errorReportedLocally: true },
    onError: (error) => captureException(error, { context: "climbing-attempt-log" }),
    onSuccess: async () => {
      await Promise.all([
        utils.climbing.invalidate(),
        utils.mobileDashboard.training.invalidate(),
        utils.activity.invalidate(),
      ]);
    },
  });

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.section}>
        <Text style={styles.title}>Finger loading</Text>
        <Text style={styles.subtitle}>Fast structured logging for hangs and board work.</Text>
        {history.error && !history.data ? (
          <QueryStatePanel
            message={getQueryErrorMessage(history.error)}
            minHeight={120}
            variant="error"
          />
        ) : (
          <FingerLoadingLog
            errorMessage={fingerMutation.error?.message ?? null}
            latest={history.data?.[0] ?? null}
            loading={history.isLoading}
            onSubmit={(input: FingerLoadingSubmission) => fingerMutation.mutate(input)}
            submitting={fingerMutation.isPending}
            unitSystem={units.system}
          />
        )}
      </View>
      <View style={styles.section}>
        <Text style={styles.title}>Climbing attempts</Text>
        <Text style={styles.subtitle}>
          Capture the wall, holds, result, and reason for every attempt.
        </Text>
        <ClimbingAttemptLog
          errorMessage={climbingMutation.error?.message ?? null}
          onSubmit={(input: ClimbingSessionSubmission) => climbingMutation.mutate(input)}
          submitting={climbingMutation.isPending}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: colors.background, flex: 1 },
  content: { gap: spacing.lg, padding: spacing.md },
  section: { gap: spacing.sm },
  subtitle: { color: colors.textSecondary },
  title: { color: colors.text, fontSize: 20, fontWeight: "700" },
});
