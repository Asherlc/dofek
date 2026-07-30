import { formatRelativeTime } from "@dofek/format/format";
import {
  PROCESSING_ALERTS_EMPTY_PREVIEW,
  type ProcessingAlert,
  processingAlertsFailurePresentation,
} from "@dofek/providers/processing-alerts";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { EmptyStatePreview } from "../components/EmptyStatePreview";
import { PaginationControls } from "../components/PaginationControls";
import { QueryStatePanel } from "../components/QueryStatePanel";
import { trpc } from "../lib/trpc";
import { useProcessingAlerts } from "../lib/useProcessingAlerts";
import { colors, radius, spacing } from "../theme";

const PAGE_SIZE = 20;

export default function AlertsScreen() {
  const alertsQuery = useProcessingAlerts();
  const router = useRouter();
  const trpcUtils = trpc.useUtils();
  const [startedProviderId, setStartedProviderId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const syncMutation = trpc.sync.triggerSync.useMutation({
    onSuccess: async (_result, variables) => {
      setStartedProviderId(variables.providerId ?? null);
      await trpcUtils.processing.alerts.invalidate();
    },
  });

  function handleAction(alert: ProcessingAlert) {
    if (alert.action === "retry_sync" && alert.providerId) {
      syncMutation.mutate({ providerId: alert.providerId, sinceDays: 7 });
      return;
    }
    if (alert.action === "reconnect" && alert.providerId) {
      router.push(`/providers/${alert.providerId}`);
      return;
    }
    if (alert.action === "retry_import") {
      router.push("/providers");
      return;
    }
    router.push("/support");
  }

  const alerts = alertsQuery.data?.alerts ?? [];
  const totalPages = Math.ceil(alerts.length / PAGE_SIZE);
  const currentPage = Math.min(page, Math.max(totalPages - 1, 0));
  const visibleAlerts = alerts.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const failurePresentation = alertsQuery.error
    ? processingAlertsFailurePresentation({
        errorMessage: alertsQuery.error.message,
        hasSnapshot: alertsQuery.data !== undefined,
        lastCheckedLabel: alertsQuery.data
          ? formatRelativeTime(alertsQuery.data.generatedAt)
          : null,
      })
    : null;
  const failurePanel = failurePresentation ? (
    <QueryStatePanel
      variant="error"
      title={failurePresentation.title}
      message={failurePresentation.message}
      onRetry={() => void alertsQuery.refetch()}
      retryLabel={failurePresentation.retryLabel}
      retrying={alertsQuery.isFetching}
    />
  ) : null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.intro}>
        Problems that need your attention appear here until they are resolved.
      </Text>
      {alertsQuery.isLoading && !alertsQuery.data ? (
        <QueryStatePanel variant="loading" />
      ) : failurePresentation && (!alertsQuery.data || alerts.length === 0) ? (
        failurePanel
      ) : alertsQuery.data?.alerts.length === 0 ? (
        <EmptyStatePreview content={PROCESSING_ALERTS_EMPTY_PREVIEW} />
      ) : (
        <View style={styles.list}>
          {failurePanel}
          {visibleAlerts.map((alert) => (
            <View key={alert.id} style={styles.card}>
              <Text style={styles.title}>{alert.title}</Text>
              <Text style={styles.message}>{alert.message}</Text>
              <Text style={styles.time}>{formatRelativeTime(alert.occurredAt)}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={alert.actionLabel}
                disabled={syncMutation.isPending}
                onPress={() => handleAction(alert)}
                style={({ pressed }) => [
                  styles.action,
                  pressed && styles.actionPressed,
                  syncMutation.isPending && styles.actionDisabled,
                ]}
              >
                <Text style={styles.actionText}>{alert.actionLabel}</Text>
              </Pressable>
              {startedProviderId === alert.providerId && alert.providerLabel ? (
                <Text style={styles.success} accessibilityRole="summary">
                  {alert.providerLabel} sync started.
                </Text>
              ) : null}
              {syncMutation.error && syncMutation.variables?.providerId === alert.providerId ? (
                <Text style={styles.error} accessibilityRole="alert">
                  {syncMutation.error.message}
                </Text>
              ) : null}
            </View>
          ))}
          <PaginationControls
            page={currentPage}
            pageSize={PAGE_SIZE}
            totalItems={alerts.length}
            itemLabel="alerts"
            onPageChange={setPage}
          />
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: colors.background,
    flex: 1,
  },
  content: {
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  intro: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: spacing.md,
  },
  list: {
    gap: spacing.sm,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.surfaceSecondary,
    borderLeftColor: colors.danger,
    borderLeftWidth: 4,
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.md,
  },
  title: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  message: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    marginTop: spacing.xs,
  },
  time: {
    color: colors.textTertiary,
    fontSize: 12,
    marginTop: spacing.sm,
  },
  action: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  actionPressed: {
    opacity: 0.8,
  },
  actionDisabled: {
    opacity: 0.5,
  },
  actionText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "700",
  },
  success: {
    color: colors.positive,
    fontSize: 12,
    fontWeight: "600",
    marginTop: spacing.sm,
  },
  error: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: "600",
    marginTop: spacing.sm,
  },
});
