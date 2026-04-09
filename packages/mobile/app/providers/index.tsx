import type { ProviderStats } from "@dofek/providers/provider-stats";
import { File as ExpoFile } from "expo-file-system";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useAuth } from "../../lib/auth-context";
import { importSharedFile, type ShareImportProgress } from "../../lib/share-import";
import { captureException } from "../../lib/telemetry";
import { trpc } from "../../lib/trpc";
import { useRefresh } from "../../lib/useRefresh";
import { colors } from "../../theme";
import { CredentialAuthModal, GarminAuthModal, WhoopAuthModal } from "./auth-modals.tsx";
import {
  importProviderLabel,
  type Provider,
  ProviderCard,
  type SyncLog,
  SyncLogRow,
} from "./provider-card.tsx";
import { styles } from "./styles.ts";

async function readBlobFromFileUri(fileUri: string): Promise<Blob> {
  const file = new ExpoFile(fileUri);
  if (!file.exists) {
    // Capture diagnostic context before throwing
    captureException(new Error("Shared file does not exist"), {
      context: "readBlobFromFileUri",
      fileUri,
      fileUriLength: fileUri.length,
      resolvedUri: file.uri,
    });
    throw new Error(`Shared file does not exist: ${fileUri}`);
  }
  const bytes = await file.bytes();
  return new Blob([bytes], { type: file.type || "application/octet-stream" });
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
  const [whoopAuthOpen, setWhoopAuthOpen] = useState(false);
  const [garminAuthOpen, setGarminAuthOpen] = useState(false);

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

  const sharedFileUri = Array.isArray(params.sharedFile) ? params.sharedFile[0] : params.sharedFile;

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
            if (
              providerStatus &&
              (providerStatus.status === "running" || providerStatus.status === "pending")
            ) {
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
            if (
              providerStatus &&
              (providerStatus.status === "running" || providerStatus.status === "pending")
            ) {
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
        captureException(error, { context: "share-import", fileUri: sharedFileUri });
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

  const handleSyncAll = useCallback(
    async (fullSync = false) => {
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
    },
    [syncMutation, providers.data, pollJob],
  );

  const handleConnect = useCallback(
    async (provider: { id: string; label: string; authType: string }) => {
      switch (provider.authType) {
        case "oauth":
        case "oauth1":
          if (!sessionToken) break;
          await WebBrowser.openBrowserAsync(
            `${serverUrl}/auth/provider/${provider.id}?session=${encodeURIComponent(sessionToken)}`,
          );
          await trpcUtils.sync.providers.invalidate();
          break;
        case "credential":
          setCredentialAuthProvider({ id: provider.id, name: provider.label });
          break;
        case "custom:whoop":
          setWhoopAuthOpen(true);
          break;
        case "custom:garmin":
          setGarminAuthOpen(true);
          break;
      }
    },
    [serverUrl, sessionToken, trpcUtils],
  );

  const providerList: Provider[] = (providers.data ?? []).map((p) => ({
    id: p.id,
    label: p.name,
    enabled: p.authorized && !p.importOnly,
    authStatus: p.needsReauth ? "expired" : p.authorized ? "connected" : "not_connected",
    authType: p.authType,
    lastSyncAt: p.lastSyncedAt,
    importOnly: p.importOnly,
  }));
  const statsMap: Record<string, ProviderStats> = {};
  for (const s of stats.data ?? []) {
    statsMap[s.providerId] = s;
  }
  const logList: SyncLog[] = logs.data ?? [];

  const { refreshing, onRefresh } = useRefresh();

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
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.textSecondary}
        />
      }
    >
      {/* Sync All */}
      {enabledProviders.length > 0 && (
        <View style={styles.syncAllRow}>
          <TouchableOpacity
            style={[
              styles.syncAllButton,
              styles.syncAllButtonFlex,
              anySyncing && styles.syncAllButtonDisabled,
            ]}
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
          Export a CSV, XML, or ZIP file from Strong, Cronometer, or Apple Health and share it to
          Dofek.
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
      {/* WHOOP Auth Modal */}
      {whoopAuthOpen && (
        <WhoopAuthModal
          onClose={() => setWhoopAuthOpen(false)}
          onSuccess={() => {
            setWhoopAuthOpen(false);
            trpcUtils.sync.providers.invalidate();
          }}
        />
      )}
      {/* Garmin Auth Modal */}
      {garminAuthOpen && (
        <GarminAuthModal
          onClose={() => setGarminAuthOpen(false)}
          onSuccess={() => {
            setGarminAuthOpen(false);
            trpcUtils.sync.providers.invalidate();
          }}
        />
      )}
    </ScrollView>
  );
}
