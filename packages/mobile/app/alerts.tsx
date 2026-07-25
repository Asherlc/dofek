import { formatRelativeTime } from "@dofek/format/format";
import type { ProcessingAlert } from "@dofek/providers/processing-alerts";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { QueryStatePanel } from "../components/QueryStatePanel";
import { trpc } from "../lib/trpc";
import { useProcessingAlerts } from "../lib/useProcessingAlerts";
import { colors, radius, spacing } from "../theme";

export default function AlertsScreen() {
  const alertsQuery = useProcessingAlerts();
  const router = useRouter();
  const trpcUtils = trpc.useUtils();
  const [startedProviderId, setStartedProviderId] = useState<string | null>(null);
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

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.intro}>
        Problems that need your attention appear here until they are resolved.
      </Text>
      {alertsQuery.isLoading && !alertsQuery.data ? (
        <QueryStatePanel variant="loading" />
      ) : alertsQuery.error && !alertsQuery.data ? (
        <QueryStatePanel
          variant="error"
          title="Alerts could not be loaded"
          message="Pull down or reopen this screen to try again."
        />
      ) : alertsQuery.data?.alerts.length === 0 ? (
        <QueryStatePanel
          variant="empty"
          title="Nothing needs your attention"
          message="New sync, connection, and import problems will appear here."
        />
      ) : (
        <View style={styles.list}>
          {alertsQuery.data?.alerts.map((alert) => (
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
