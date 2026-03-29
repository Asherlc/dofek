import type { ProviderStats } from "@dofek/providers/provider-stats";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { File as ExpoFile } from "expo-file-system";
import * as WebBrowser from "expo-web-browser";
import { trpc } from "../lib/trpc";
import { useRefresh } from "../lib/useRefresh";
import { useAuth } from "../lib/auth-context";
import { importSharedFile, type ShareImportProgress } from "../lib/share-import";
import { ProviderStatsBreakdown } from "../components/ProviderStatsBreakdown";
import { ProviderLogo } from "../components/ProviderLogo";
import { colors } from "../theme";
import { formatRelativeTime } from "@dofek/format/format";

function readBlobFromFileUri(fileUri: string): Promise<Blob> {
  return Promise.resolve(new ExpoFile(fileUri));
}

type AuthStatus = "connected" | "not_connected" | "expired";

interface Provider {
  id: string;
  label: string;
  enabled: boolean;
  authStatus: AuthStatus;
  authType: string;
  lastSyncAt: string | null;
  importOnly: boolean;
}


interface SyncLog {
  id: string;
  providerId: string;
  dataType: string;
  status: string;
  recordCount: number | null;
  durationMs: number | null;
  errorMessage: string | null;
  syncedAt: string;
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

export function providerActionLabel(authStatus: AuthStatus): "Sync" | "Connect" {
  return authStatus === "connected" ? "Sync" : "Connect";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function importProviderLabel(providerId: string | undefined): string {
  switch (providerId) {
    case "apple-health":
      return "Apple Health";
    case "strong-csv":
      return "Strong";
    case "cronometer-csv":
      return "Cronometer";
    default:
      return "Shared file";
  }
}

export function ProviderCard({
  provider,
  stats,
  syncing,
  syncProgress,
  onSync,
  onFullSync,
  onConnect,
  onPress,
}: {
  provider: Provider;
  stats: ProviderStats | undefined;
  syncing: boolean;
  syncProgress: { percentage?: number; message?: string } | undefined;
  onSync: () => void;
  onFullSync: () => void;
  onConnect: () => void;
  onPress: () => void;
}) {
  const dotColor = statusDotColor(provider.authStatus);

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleRow}>
          <ProviderLogo provider={provider.id} size={24} />
          <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
          <Text style={styles.cardTitle}>{provider.label}</Text>
        </View>
        {!provider.importOnly && (
          <TouchableOpacity
            style={[styles.syncButton, syncing && styles.syncButtonDisabled]}
            onPress={provider.authStatus === "connected" ? onSync : onConnect}
            activeOpacity={0.7}
            disabled={syncing}
          >
            {syncing ? (
              <ActivityIndicator color={colors.text} size="small" />
            ) : (
              <Text style={styles.syncButtonText}>
                {providerActionLabel(provider.authStatus)}
              </Text>
            )}
          </TouchableOpacity>
        )}
      </View>

      {syncing && syncProgress ? (
        <View style={styles.syncProgressContainer}>
          {syncProgress.percentage != null && (
            <View style={styles.syncProgressTrack}>
              <View
                style={[
                  styles.syncProgressFill,
                  {
                    width: `${Math.max(0, Math.min(100, syncProgress.percentage))}%`,
                  },
                ]}
              />
            </View>
          )}
          {syncProgress.message ? (
            <Text style={styles.syncProgressMessage}>{syncProgress.message}</Text>
          ) : null}
        </View>
      ) : (
        <View style={styles.cardMeta}>
          <Text style={styles.cardMetaText}>
            {provider.importOnly ? "Import only" : statusLabel(provider.authStatus)}
          </Text>
          {!provider.importOnly && (
            provider.lastSyncAt && formatRelativeTime(provider.lastSyncAt) ? (
              <Text style={styles.cardMetaText}>
                Last sync: {formatRelativeTime(provider.lastSyncAt)}
              </Text>
            ) : (
              <Text style={styles.cardMetaText}>Never synced</Text>
            )
          )}
          {provider.authStatus === "connected" && !syncing && !provider.importOnly && (
            <TouchableOpacity onPress={onFullSync} activeOpacity={0.7}>
              <Text style={styles.fullSyncLink}>Full sync</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {stats && <ProviderStatsBreakdown stats={stats} />}
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
          <Text style={styles.logProvider}>{log.providerId}</Text>
          <Text style={styles.logDataType}>{log.dataType}</Text>
        </View>
        <View style={styles.logDetails}>
          <Text style={styles.logDetailText}>
            {(log.recordCount ?? 0).toLocaleString()} records
          </Text>
          <Text style={styles.logDetailText}>{formatDuration(log.durationMs ?? 0)}</Text>
          <Text style={styles.logDetailText}>
            {formatRelativeTime(log.syncedAt) ?? ""}
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
  const { serverUrl, sessionToken } = useAuth();
  const params = useLocalSearchParams<{ sharedFile?: string | string[] }>();
  const providers = trpc.sync.providers.useQuery();
  const stats = trpc.sync.providerStats.useQuery();
  const logs = trpc.sync.logs.useQuery({ limit: 50 });
  const syncMutation = trpc.sync.triggerSync.useMutation();
  const trpcUtils = trpc.useUtils();
  const activeSyncs = trpc.sync.activeSyncs.useQuery(undefined, { staleTime: 0 });

  // Auth modal state
  const [credentialAuthProvider, setCredentialAuthProvider] = useState<{
    id: string;
    name: string;
  } | null>(null);

  // Track which providers are currently syncing (from active jobs or user-initiated)
  const [syncingProviders, setSyncingProviders] = useState<Set<string>>(new Set());
  const [syncProgress, setSyncProgress] = useState<
    Record<string, { percentage?: number; message?: string }>
  >({});
  const [anySyncing, setAnySyncing] = useState(false);
  const [sharedImportState, setSharedImportState] = useState<ShareImportProgress | null>(null);
  const resumedJobIds = useRef(new Set<string>());
  const pollingJobIds = useRef(new Set<string>());
  const importedSharedUris = useRef(new Set<string>());

  const sharedFileUri = Array.isArray(params.sharedFile)
    ? params.sharedFile[0]
    : params.sharedFile;

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
        setSyncProgress((prev) => {
          const next = { ...prev };
          for (const pid of providerIds) delete next[pid];
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

        // Update per-provider syncing state and progress (only for this job's providers)
        setSyncingProviders((prev) => {
          const next = new Set(prev);
          for (const pid of providerIds) {
            const providerStatus = status.providers[pid];
            if (providerStatus && (providerStatus.status === "running" || providerStatus.status === "pending")) {
              next.add(pid);
            } else {
              next.delete(pid);
            }
          }
          return next;
        });
        setSyncProgress((prev) => {
          const next = { ...prev };
          for (const pid of providerIds) {
            const providerStatus = status.providers[pid];
            if (providerStatus && (providerStatus.status === "running" || providerStatus.status === "pending")) {
              next[pid] = {
                percentage: status.percentage,
                message: providerStatus.message,
              };
            } else {
              delete next[pid];
            }
          }
          return next;
        });

        if (status.status === "done" || status.status === "error") {
          pollingJobIds.current.delete(jobId);
          if (pollingJobIds.current.size === 0) {
            setAnySyncing(false);
          }
          trpcUtils.invalidate();
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
        for (const [pid, providerStatus] of Object.entries(activeJob.providers)) {
          if (providerStatus.status === "running" || providerStatus.status === "pending") {
            next.add(pid);
          }
        }
        return next;
      });
      setAnySyncing(true);
      pollJob(activeJob.jobId, providerIds);
    }
  }, [activeSyncs.data, pollJob]);

  useEffect(() => {
    if (!sharedFileUri) return;
    if (!sessionToken) return;
    if (importedSharedUris.current.has(sharedFileUri)) return;
    importedSharedUris.current.add(sharedFileUri);

    void (async () => {
      try {
        await importSharedFile(
          {
            fileUri: sharedFileUri,
            serverUrl,
            sessionToken,
            onProgress: setSharedImportState,
          },
          { readBlob: readBlobFromFileUri },
        );
        trpcUtils.invalidate();
      } catch (error: unknown) {
        setSharedImportState({
          status: "error",
          progress: 0,
          message: error instanceof Error ? error.message : "Import failed",
        });
      }
    })();
  }, [sharedFileUri, serverUrl, sessionToken, trpcUtils]);

  const handleSyncProvider = useCallback(
    async (providerId: string, fullSync = false) => {
      setSyncingProviders((prev) => new Set(prev).add(providerId));
      setAnySyncing(true);
      try {
        const { jobId } = await syncMutation.mutateAsync({
          providerId,
          sinceDays: fullSync ? undefined : 7,
        });
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

  const handleSyncAll = useCallback(async (fullSync = false) => {
    const enabled = (providers.data ?? []).filter((p) => p.authorized && !p.importOnly);
    const ids = enabled.map((p) => p.id);
    if (ids.length === 0) return;
    setSyncingProviders(new Set(ids));
    setAnySyncing(true);
    try {
      const result = await syncMutation.mutateAsync({
        sinceDays: fullSync ? undefined : 7,
      });
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

  const handleConnect = useCallback(
    async (provider: { id: string; label: string; authType: string }) => {
      switch (provider.authType) {
        case "oauth":
        case "oauth1":
          await WebBrowser.openBrowserAsync(`${serverUrl}/auth/provider/${provider.id}`);
          trpcUtils.sync.providers.invalidate();
          break;
        case "credential":
          setCredentialAuthProvider({ id: provider.id, name: provider.label });
          break;
      }
    },
    [serverUrl, trpcUtils],
  );

  const providerList: Provider[] = (providers.data ?? []).map((p) => ({
    id: p.id,
    label: p.name,
    enabled: p.authorized && !p.importOnly,
    authStatus: p.authorized ? "connected" : "not_connected",
    authType: p.authType,
    lastSyncAt: p.lastSyncedAt,
    importOnly: p.importOnly,
  }));
  const statsMap: Record<string, ProviderStats> = {};
  for (const s of stats.data ?? []) {
    statsMap[s.providerId] = s;
  }
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

  const { refreshing, onRefresh } = useRefresh();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} />}>
      {/* Sync All */}
      {enabledProviders.length > 0 && (
        <View style={styles.syncAllRow}>
          <TouchableOpacity
            style={[styles.syncAllButton, styles.syncAllButtonFlex, anySyncing && styles.syncAllButtonDisabled]}
            onPress={() => handleSyncAll(false)}
            activeOpacity={0.7}
            disabled={anySyncing}
          >
            {anySyncing ? (
              <ActivityIndicator color={colors.text} size="small" />
            ) : (
              <Text style={styles.syncAllButtonText}>Sync All</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.fullSyncAllButton, anySyncing && styles.syncAllButtonDisabled]}
            onPress={() => handleSyncAll(true)}
            activeOpacity={0.7}
            disabled={anySyncing}
          >
            <Text style={styles.fullSyncAllButtonText}>Full Sync All</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.shareInfoCard}>
        <Text style={styles.shareInfoTitle}>Import from Share</Text>
        <Text style={styles.shareInfoDescription}>
          Export a CSV, XML, or ZIP file from Strong, Cronometer, or Apple Health and share it to Dofek.
        </Text>
        {sharedImportState ? (
          <View style={styles.shareImportState}>
            <Text style={styles.shareImportTitle}>
              {sharedImportState.status === "done"
                ? `${importProviderLabel(sharedImportState.providerId)} import complete`
                : `${importProviderLabel(sharedImportState.providerId)} import ${sharedImportState.status}`}
            </Text>
            <Text
              style={[
                styles.shareImportMessage,
                sharedImportState.status === "error" && styles.shareImportError,
              ]}
            >
              {sharedImportState.message}
            </Text>
            {sharedImportState.status !== "error" && (
              <View style={styles.shareProgressTrack}>
                <View
                  style={[
                    styles.shareProgressFill,
                    { width: `${Math.max(0, Math.min(100, sharedImportState.progress))}%` },
                  ]}
                />
              </View>
            )}
          </View>
        ) : null}
      </View>

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
            syncProgress={syncProgress[provider.id]}
            onSync={() => handleSyncProvider(provider.id)}
            onFullSync={() => handleSyncProvider(provider.id, true)}
            onConnect={() => handleConnect(provider)}
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
      {/* Credential Auth Modal */}
      {credentialAuthProvider && (
        <CredentialAuthModal
          providerId={credentialAuthProvider.id}
          providerName={credentialAuthProvider.name}
          onClose={() => setCredentialAuthProvider(null)}
          onSuccess={() => {
            setCredentialAuthProvider(null);
            trpcUtils.sync.providers.invalidate();
          }}
        />
      )}
    </ScrollView>
  );
}

// ── Generic Credential Auth Modal ──

function CredentialAuthModal({
  providerId,
  providerName,
  onClose,
  onSuccess,
}: {
  providerId: string;
  providerName: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const emailRef = useRef<TextInput>(null);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  const signInMutation = trpc.credentialAuth.signIn.useMutation();

  const handleSignIn = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      await signInMutation.mutateAsync({ providerId, username, password });
      onSuccess();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setLoading(false);
    }
  }, [providerId, username, password, signInMutation, onSuccess]);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Connect {providerName}</Text>
            <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
              <Text style={styles.modalClose}>{"\u00D7"}</Text>
            </TouchableOpacity>
          </View>

          {error ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <TextInput
            ref={emailRef}
            style={styles.input}
            placeholder="Email"
            placeholderTextColor={colors.textTertiary}
            value={username}
            onChangeText={setUsername}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={styles.input}
            placeholder="Password"
            placeholderTextColor={colors.textTertiary}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />
          <TouchableOpacity
            style={[styles.signInButton, loading && styles.signInButtonDisabled]}
            onPress={handleSignIn}
            activeOpacity={0.7}
            disabled={loading || !username || !password}
          >
            <Text style={styles.signInButtonText}>
              {loading ? "Signing in..." : "Sign In"}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
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

  // Sync All buttons
  syncAllRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 20,
  },
  syncAllButton: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  syncAllButtonFlex: {
    flex: 1,
  },
  syncAllButtonDisabled: {
    opacity: 0.5,
  },
  syncAllButtonText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  fullSyncAllButton: {
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.accent,
  },
  fullSyncAllButtonText: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: "600",
  },
  fullSyncLink: {
    fontSize: 13,
    color: colors.accent,
    marginTop: 4,
  },
  shareInfoCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
  },
  shareInfoTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
    marginBottom: 4,
  },
  shareInfoDescription: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 19,
  },
  shareImportState: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surfaceSecondary,
  },
  shareImportTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.text,
    textTransform: "capitalize",
  },
  shareImportMessage: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 4,
  },
  shareImportError: {
    color: colors.danger,
  },
  shareProgressTrack: {
    marginTop: 8,
    height: 6,
    borderRadius: 999,
    backgroundColor: colors.surfaceSecondary,
    overflow: "hidden",
  },
  shareProgressFill: {
    height: "100%",
    backgroundColor: colors.accent,
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

  // Sync progress
  syncProgressContainer: {
    marginTop: 8,
    gap: 4,
  },
  syncProgressTrack: {
    height: 6,
    borderRadius: 999,
    backgroundColor: colors.surfaceSecondary,
    overflow: "hidden" as const,
  },
  syncProgressFill: {
    height: "100%" as const,
    backgroundColor: colors.accent,
  },
  syncProgressMessage: {
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

  // Credential Auth Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  modalContent: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 20,
    width: "100%",
    maxWidth: 340,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.text,
  },
  modalClose: {
    fontSize: 22,
    color: colors.textSecondary,
    paddingHorizontal: 4,
  },
  errorBanner: {
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
  },
  errorText: {
    fontSize: 13,
    color: colors.danger,
  },
  input: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: colors.text,
    marginBottom: 10,
  },
  signInButton: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 4,
  },
  signInButtonDisabled: {
    opacity: 0.5,
  },
  signInButtonText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "600",
  },
});
