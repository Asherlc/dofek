import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";
import { formatRelativeTime } from "@dofek/shared/format";

type AuthStatus = "connected" | "not_connected" | "expired";

interface Provider {
  id: string;
  label: string;
  enabled: boolean;
  authStatus: AuthStatus;
  lastSyncAt: string | null;
}

interface ProviderStats {
  activities: number;
  sleep: number;
  body: number;
  food: number;
  metrics: number;
}

interface SyncLog {
  id: string;
  provider: string;
  dataType: string;
  status: "success" | "error";
  recordCount: number;
  durationMs: number;
  errorMessage: string | null;
  createdAt: string;
}

function statusDotColor(authStatus: AuthStatus): string {
  switch (authStatus) {
    case "connected":
      return colors.positive;
    case "expired":
      return colors.warning;
    case "not_connected":
      return colors.textTertiary;
  }
}

function statusLabel(authStatus: AuthStatus): string {
  switch (authStatus) {
    case "connected":
      return "Connected";
    case "expired":
      return "Expired";
    case "not_connected":
      return "Not connected";
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function StatBadge({ label, count }: { label: string; count: number }) {
  if (count === 0) return null;
  return (
    <View style={styles.statBadge}>
      <Text style={styles.statBadgeCount}>{count.toLocaleString()}</Text>
      <Text style={styles.statBadgeLabel}>{label}</Text>
    </View>
  );
}

function ProviderCard({
  provider,
  stats,
  syncing,
  onSync,
  onPress,
}: {
  provider: Provider;
  stats: ProviderStats | undefined;
  syncing: boolean;
  onSync: () => void;
  onPress: () => void;
}) {
  const dotColor = statusDotColor(provider.authStatus);

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleRow}>
          <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
          <Text style={styles.cardTitle}>{provider.label}</Text>
        </View>
        <TouchableOpacity
          style={[styles.syncButton, syncing && styles.syncButtonDisabled]}
          onPress={onSync}
          activeOpacity={0.7}
          disabled={syncing || provider.authStatus !== "connected"}
        >
          {syncing ? (
            <ActivityIndicator color={colors.text} size="small" />
          ) : (
            <Text style={styles.syncButtonText}>Sync</Text>
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.cardMeta}>
        <Text style={styles.cardMetaText}>{statusLabel(provider.authStatus)}</Text>
        {provider.lastSyncAt ? (
          <Text style={styles.cardMetaText}>
            Last sync: {formatRelativeTime(provider.lastSyncAt)}
          </Text>
        ) : (
          <Text style={styles.cardMetaText}>Never synced</Text>
        )}
      </View>

      {stats && (
        <View style={styles.statsRow}>
          <StatBadge label="activities" count={stats.activities} />
          <StatBadge label="sleep" count={stats.sleep} />
          <StatBadge label="body" count={stats.body} />
          <StatBadge label="food" count={stats.food} />
          <StatBadge label="metrics" count={stats.metrics} />
        </View>
      )}
    </TouchableOpacity>
  );
}

function SyncLogRow({ log }: { log: SyncLog }) {
  const isError = log.status === "error";

  return (
    <View style={styles.logRow}>
      <View style={styles.logLeft}>
        <View style={styles.logTitleRow}>
          <View
            style={[
              styles.statusDot,
              { backgroundColor: isError ? colors.danger : colors.positive },
            ]}
          />
          <Text style={styles.logProvider}>{log.provider}</Text>
          <Text style={styles.logDataType}>{log.dataType}</Text>
        </View>
        <View style={styles.logDetails}>
          <Text style={styles.logDetailText}>
            {log.recordCount.toLocaleString()} records
          </Text>
          <Text style={styles.logDetailText}>{formatDuration(log.durationMs)}</Text>
          <Text style={styles.logDetailText}>
            {formatRelativeTime(log.createdAt)}
          </Text>
        </View>
        {isError && log.errorMessage ? (
          <Text style={styles.logError} numberOfLines={2}>
            {log.errorMessage}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export default function ProvidersScreen() {
  const router = useRouter();
  const providers = trpc.sync.providers.useQuery();
  const stats = trpc.sync.providerStats.useQuery();
  const logs = trpc.sync.logs.useQuery({ limit: 50 });
  const syncMutation = trpc.sync.triggerSync.useMutation();
  const trpcUtils = trpc.useUtils();
  const activeSyncs = trpc.sync.activeSyncs.useQuery(undefined, { staleTime: 0 });

  // Track which providers are currently syncing (from active jobs or user-initiated)
  const [syncingProviders, setSyncingProviders] = useState<Set<string>>(new Set());
  const [anySyncing, setAnySyncing] = useState(false);
  const resumedJobIds = useRef(new Set<string>());
  const pollingJobIds = useRef(new Set<string>());

  const pollJob = useCallback(
    async (jobId: string, providerIds: string[]) => {
      if (pollingJobIds.current.has(jobId)) return;
      pollingJobIds.current.add(jobId);

      const cleanup = () => {
        pollingJobIds.current.delete(jobId);
        setSyncingProviders((prev) => {
          const next = new Set(prev);
          for (const pid of providerIds) next.delete(pid);
          return next;
        });
        if (pollingJobIds.current.size === 0) {
          setAnySyncing(false);
        }
      };

      const poll = async (): Promise<void> => {
        let status: Awaited<ReturnType<typeof trpcUtils.sync.syncStatus.fetch>>;
        try {
          status = await trpcUtils.sync.syncStatus.fetch({ jobId }, { staleTime: 0 });
        } catch {
          cleanup();
          return;
        }

        if (!status) {
          cleanup();
          return;
        }

        // Update per-provider syncing state (only for this job's providers)
        setSyncingProviders((prev) => {
          const next = new Set(prev);
          for (const pid of providerIds) {
            const pStatus = status.providers[pid];
            if (pStatus && (pStatus.status === "running" || pStatus.status === "pending")) {
              next.add(pid);
            } else {
              next.delete(pid);
            }
          }
          return next;
        });

        if (status.status === "done" || status.status === "error") {
          pollingJobIds.current.delete(jobId);
          if (pollingJobIds.current.size === 0) {
            setAnySyncing(false);
          }
          trpcUtils.sync.providers.invalidate();
          trpcUtils.sync.providerStats.invalidate();
          trpcUtils.sync.logs.invalidate();
          return;
        }

        await new Promise((r) => setTimeout(r, 1000));
        return poll();
      };

      return poll();
    },
    [trpcUtils],
  );

  // Resume polling for active sync jobs on mount
  useEffect(() => {
    if (!activeSyncs.data) return;
    for (const activeJob of activeSyncs.data) {
      if (activeJob.status !== "running") continue;
      if (resumedJobIds.current.has(activeJob.jobId)) continue;
      resumedJobIds.current.add(activeJob.jobId);

      const providerIds = Object.keys(activeJob.providers);
      setSyncingProviders((prev) => {
        const next = new Set(prev);
        for (const [pid, pStatus] of Object.entries(activeJob.providers)) {
          if (pStatus.status === "running" || pStatus.status === "pending") {
            next.add(pid);
          }
        }
        return next;
      });
      setAnySyncing(true);
      pollJob(activeJob.jobId, providerIds);
    }
  }, [activeSyncs.data, pollJob]);

  const handleSyncProvider = useCallback(
    async (providerId: string) => {
      setSyncingProviders((prev) => new Set(prev).add(providerId));
      setAnySyncing(true);
      try {
        const { jobId } = await syncMutation.mutateAsync({ providerId, sinceDays: 7 });
        await pollJob(jobId, [providerId]);
      } catch {
        setSyncingProviders((prev) => {
          const next = new Set(prev);
          next.delete(providerId);
          return next;
        });
        setAnySyncing(false);
      }
    },
    [syncMutation, pollJob],
  );

  const handleSyncAll = useCallback(async () => {
    const enabled = (providers.data ?? []).filter((p) => p.authorized && !p.importOnly);
    const ids = enabled.map((p) => p.id);
    if (ids.length === 0) return;
    setSyncingProviders(new Set(ids));
    setAnySyncing(true);
    try {
      const result = await syncMutation.mutateAsync({ sinceDays: 7 });
      const providerJobMap = new Map(
        (result.providerJobs ?? []).map((job) => [job.providerId, job.jobId] as const),
      );
      if (providerJobMap.size > 0) {
        await Promise.all(
          ids.map(async (providerId) => {
            const jobId = providerJobMap.get(providerId);
            if (!jobId) {
              setSyncingProviders((prev) => {
                const next = new Set(prev);
                next.delete(providerId);
                return next;
              });
              return;
            }
            await pollJob(jobId, [providerId]);
          }),
        );
      } else {
        await pollJob(result.jobId, ids);
      }
    } catch {
      setSyncingProviders(new Set());
      setAnySyncing(false);
    }
  }, [syncMutation, providers.data, pollJob]);

  const providerList: Provider[] = (providers.data ?? []).map((p) => ({
    id: p.id,
    label: p.name,
    enabled: p.authorized && !p.importOnly,
    authStatus: p.authorized ? "connected" : "not_connected",
    lastSyncAt: p.lastSyncedAt,
  }));
  const statsMap: Record<string, ProviderStats> = stats.data ?? {};
  const logList: SyncLog[] = logs.data ?? [];

  const isLoading = providers.isLoading || stats.isLoading;
  const enabledProviders = providerList.filter((p) => p.enabled);

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Sync All */}
      {enabledProviders.length > 0 && (
        <TouchableOpacity
          style={[styles.syncAllButton, anySyncing && styles.syncAllButtonDisabled]}
          onPress={handleSyncAll}
          activeOpacity={0.7}
          disabled={anySyncing}
        >
          {anySyncing ? (
            <ActivityIndicator color={colors.text} size="small" />
          ) : (
            <Text style={styles.syncAllButtonText}>Sync All</Text>
          )}
        </TouchableOpacity>
      )}

      {/* Data Sources */}
      <Text style={styles.sectionTitle}>Data Sources</Text>
      {providerList.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>No data sources configured.</Text>
        </View>
      ) : (
        providerList.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            stats={statsMap[provider.id]}
            syncing={syncingProviders.has(provider.id)}
            onSync={() => handleSyncProvider(provider.id)}
            onPress={() => router.push(`/providers/${provider.id}`)}
          />
        ))
      )}

      {/* Sync History */}
      <Text style={[styles.sectionTitle, { marginTop: 24 }]}>Sync History</Text>
      {logs.isLoading ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: 12 }} />
      ) : logList.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>No sync history yet.</Text>
        </View>
      ) : (
        <View style={styles.card}>
          {logList.map((log) => (
            <SyncLogRow key={log.id} log={log} />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: 16,
    paddingTop: 24,
    paddingBottom: 40,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: "center",
    alignItems: "center",
  },

  // Sync All button
  syncAllButton: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginBottom: 20,
  },
  syncAllButtonDisabled: {
    opacity: 0.5,
  },
  syncAllButtonText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
  },

  // Section titles
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 10,
  },

  // Provider cards
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
  },
  cardMeta: {
    marginTop: 6,
    gap: 2,
  },
  cardMetaText: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  syncButton: {
    backgroundColor: colors.accent,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 60,
  },
  syncButtonDisabled: {
    opacity: 0.5,
  },
  syncButtonText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },

  // Stats row
  statsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surfaceSecondary,
  },
  statBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.surfaceSecondary,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  statBadgeCount: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.text,
  },
  statBadgeLabel: {
    fontSize: 12,
    color: colors.textSecondary,
  },

  // Sync history logs
  logRow: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceSecondary,
  },
  logLeft: {
    gap: 4,
  },
  logTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  logProvider: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  logDataType: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  logDetails: {
    flexDirection: "row",
    gap: 12,
    marginTop: 2,
  },
  logDetailText: {
    fontSize: 12,
    color: colors.textTertiary,
  },
  logError: {
    fontSize: 12,
    color: colors.danger,
    marginTop: 4,
  },
  emptyText: {
    fontSize: 14,
    color: colors.textTertiary,
    textAlign: "center",
    paddingVertical: 8,
  },
});
