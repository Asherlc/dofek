import { formatDateYmd } from "@dofek/format/format";
import type { ProviderStats } from "@dofek/providers/provider-stats";
import { ROUTINE_SYNC_DAYS } from "@dofek/providers/sync-actions";
import * as DocumentPicker from "expo-document-picker";
import { File as ExpoFile } from "expo-file-system";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { OperationProgressBar } from "../../components/OperationProgressBar";
import { ProcessingStatusWidget } from "../../components/ProcessingStatusWidget";
import { getQueryErrorMessage, QueryStatePanel } from "../../components/QueryStatePanel";
import { useAppleHealthProviderModel } from "../../lib/apple-health-provider";
import { createProviderHandoffCode } from "../../lib/auth";
import { useAuth } from "../../lib/auth-context";
import {
  HEALTHKIT_DATABASE_INACCESSIBLE_MESSAGE,
  isHealthKitDatabaseInaccessible,
} from "../../lib/health-kit-errors";
import { syncDofekFoodToHealthKit } from "../../lib/health-kit-food-writeback";
import {
  type ImportProviderId,
  importSharedFile,
  type ShareImportProgress,
} from "../../lib/share-import";
import { captureException } from "../../lib/telemetry";
import { trpc } from "../../lib/trpc";
import { useProcessingStatus } from "../../lib/useProcessingStatus";
import { useRefresh } from "../../lib/useRefresh";
import { deleteDietarySamples, writeDietarySamples } from "../../modules/health-kit";
import { colors } from "../../theme";
import {
  CredentialAuthModal,
  GarminAuthModal,
  TokenAuthModal,
  WhoopAuthModal,
} from "./auth-modals.tsx";
import { FileImportProviderCard } from "./file-import-provider-card.tsx";
import { getFileImportProviderConfig } from "./file-import-providers.ts";
import {
  importProviderLabel,
  type Provider,
  ProviderCard,
  type SyncLog,
  SyncLogRow,
} from "./provider-card.tsx";
import { styles } from "./styles.ts";
import { SyncAllControls } from "./sync-all-controls.tsx";

async function readBlobFromFileUri(fileUri: string): Promise<Blob> {
  const file = new ExpoFile(fileUri);
  if (!file.exists) {
    const error = new Error(`Shared file does not exist: ${fileUri} (resolved: ${file.uri})`);
    throw error;
  }
  return file;
}

function deleteSharedFile(fileUri: string): void {
  const file = new ExpoFile(fileUri);
  if (file.exists) {
    file.delete();
  }
}

function ymdDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return formatDateYmd(date);
}

function todayYmd(): string {
  return formatDateYmd();
}

export default function ProvidersScreen() {
  const router = useRouter();
  const { serverUrl, sessionToken } = useAuth();
  const params = useLocalSearchParams<{ sharedFile?: string | string[] }>();
  const providers = trpc.sync.providers.useQuery();
  const stats = trpc.sync.providerStats.useQuery();
  const logs = trpc.sync.logs.useQuery({ limit: 50 });
  const processingStatus = useProcessingStatus({});
  const syncMutation = trpc.sync.triggerSync.useMutation();
  const trpcUtils = trpc.useUtils();
  const activeSyncs = trpc.sync.activeSyncs.useQuery(undefined, { staleTime: 0 });
  const activeImports = trpc.sync.activeImports.useQuery(undefined, {
    staleTime: 0,
    refetchInterval: (query) => ((query.state.data?.length ?? 0) > 0 ? 1000 : false),
  });

  // Auth modal state
  const [credentialAuthProvider, setCredentialAuthProvider] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [tokenAuthProvider, setTokenAuthProvider] = useState<{
    id: string;
    name: string;
    label: string;
    instructionsUrl: string;
  } | null>(null);
  const [whoopAuthOpen, setWhoopAuthOpen] = useState(false);
  const [garminAuthOpen, setGarminAuthOpen] = useState(false);

  // Track which providers are currently syncing (from active jobs or user-initiated)
  const [syncingProviders, setSyncingProviders] = useState<Set<string>>(new Set());
  const [syncProgress, setSyncProgress] = useState<
    Record<string, { percentage?: number; message?: string }>
  >({});
  const [anySyncing, setAnySyncing] = useState(false);
  const [syncAllError, setSyncAllError] = useState<string>();
  const [sharedImportState, setSharedImportState] = useState<ShareImportProgress | null>(null);
  const resumedJobIds = useRef(new Set<string>());
  const pollingJobIds = useRef(new Set<string>());
  const importedSharedUris = useRef(new Set<string>());
  const isMounted = useRef(true);

  useEffect(
    () => () => {
      isMounted.current = false;
    },
    [],
  );

  const sharedFileUri = Array.isArray(params.sharedFile) ? params.sharedFile[0] : params.sharedFile;

  const [healthKitSyncing, setHealthKitSyncing] = useState(false);
  const [healthKitProgress, setHealthKitProgress] = useState<string | undefined>();
  const trpcClient = trpcUtils.client;
  const appleHealth = useAppleHealthProviderModel({
    trpcClient,
    onAuthorizationError: (error) => {
      captureException(error, { context: "healthkit-permission-check" });
    },
  });

  const handleHealthKitConnect = useCallback(async () => {
    if (healthKitSyncing) return;
    setHealthKitSyncing(true);
    setHealthKitProgress("Requesting permissions...");
    try {
      const result = await appleHealth.connect();
      if (result.state.requestStatus === "unavailable") {
        setHealthKitProgress("Apple Health is unavailable on this device");
      } else if (!result.granted) {
        setHealthKitProgress("Apple Health permissions were not granted");
      } else {
        setHealthKitProgress(result.state.isConnected() ? "Connected" : undefined);
      }
    } catch (error: unknown) {
      captureException(error, { context: "healthkit-connect" });
      setHealthKitProgress(
        error instanceof Error ? error.message : "Failed to connect to Apple Health",
      );
    } finally {
      setHealthKitSyncing(false);
    }
  }, [appleHealth, healthKitSyncing]);

  const handleHealthKitSync = useCallback(async () => {
    setHealthKitSyncing(true);
    setAnySyncing(true);
    setHealthKitProgress("Starting HealthKit sync...");
    try {
      const result = await appleHealth.sync({
        syncRangeDays: 7,
        onProgress: setHealthKitProgress,
      });
      setHealthKitProgress("Writing Dofek food to Apple Health...");
      const foodWriteBack = await syncDofekFoodToHealthKit({
        trpcClient,
        healthKit: {
          writeDietarySamples,
          deleteDietarySamples,
        },
        startDate: ymdDaysAgo(7),
        endDate: todayYmd(),
      });
      const foodSummary =
        foodWriteBack.errors.length > 0
          ? `${foodWriteBack.written} foods written, ${foodWriteBack.errors.length} food errors`
          : `${foodWriteBack.written} foods written`;
      setHealthKitProgress(`Done — ${result.inserted} records synced, ${foodSummary}`);
      trpcUtils.invalidate();
    } catch (error: unknown) {
      if (!isHealthKitDatabaseInaccessible(error)) {
        captureException(error, { context: "healthkit-manual-sync" });
        setHealthKitProgress(error instanceof Error ? error.message : "Sync failed");
        return;
      }
      setHealthKitProgress(HEALTHKIT_DATABASE_INACCESSIBLE_MESSAGE);
    } finally {
      setHealthKitSyncing(false);
      setAnySyncing(false);
    }
  }, [appleHealth, trpcClient, trpcUtils]);

  const pollJob = useCallback(
    async (jobId: string, providerIds: string[]) => {
      if (pollingJobIds.current.has(jobId)) return;
      pollingJobIds.current.add(jobId);
      const activeProviderIds = new Set(providerIds);

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
        if (!isMounted.current) return;
        let status: Awaited<ReturnType<typeof trpcUtils.sync.syncStatus.fetch>>;
        try {
          status = await trpcUtils.sync.syncStatus.fetch({ jobId }, { staleTime: 0 });
        } catch (error: unknown) {
          captureException(error, { context: "sync-status-poll" });
          if (!isMounted.current) return;
          const message =
            error instanceof Error ? error.message : "Sync status is temporarily unavailable.";
          setSyncProgress((previous) => {
            const next = { ...previous };
            for (const providerId of activeProviderIds) {
              next[providerId] = { ...next[providerId], message };
            }
            return next;
          });
          await new Promise((resolve) => setTimeout(resolve, 1000));
          if (!isMounted.current) return;
          return poll();
        }

        if (!isMounted.current) return;
        if (!status) {
          cleanup();
          return;
        }

        for (const providerId of providerIds) {
          const providerStatus = status.providers[providerId];
          if (
            providerStatus &&
            (providerStatus.status === "running" || providerStatus.status === "pending")
          ) {
            activeProviderIds.add(providerId);
          } else {
            activeProviderIds.delete(providerId);
          }
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

        if (status.status === "completed" || status.status === "failed") {
          pollingJobIds.current.delete(jobId);
          if (pollingJobIds.current.size === 0) {
            setAnySyncing(false);
          }
          trpcUtils.invalidate();
          return;
        }

        await new Promise((r) => setTimeout(r, 1000));
        if (!isMounted.current) return;
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
      if (activeJob.status !== "running" && activeJob.status !== "queued") continue;
      if (resumedJobIds.current.has(activeJob.jobId)) continue;
      resumedJobIds.current.add(activeJob.jobId);

      const activeProviderIds = Object.entries(activeJob.providers)
        .filter(
          ([, providerStatus]) =>
            providerStatus.status === "running" || providerStatus.status === "pending",
        )
        .map(([providerId]) => providerId);
      setSyncingProviders((prev) => {
        const next = new Set(prev);
        for (const [pid, providerStatus] of Object.entries(activeJob.providers)) {
          if (providerStatus.status === "running" || providerStatus.status === "pending") {
            next.add(pid);
          }
        }
        return next;
      });
      setSyncProgress((previous) => {
        const next = { ...previous };
        for (const [providerId, providerStatus] of Object.entries(activeJob.providers)) {
          if (providerStatus.status === "running" || providerStatus.status === "pending") {
            next[providerId] = {
              percentage: activeJob.percentage,
              message: providerStatus.message,
            };
          }
        }
        return next;
      });
      setAnySyncing(true);
      pollJob(activeJob.jobId, activeProviderIds);
    }
  }, [activeSyncs.data, pollJob]);

  const importFile = useCallback(
    async (fileUri: string, providerId?: ImportProviderId) => {
      try {
        if (!sessionToken) {
          throw new Error("Sign in before importing a file");
        }
        await importSharedFile(
          {
            fileUri,
            providerId,
            serverUrl,
            sessionToken,
            onProgress: setSharedImportState,
          },
          { readBlob: readBlobFromFileUri },
        );
        trpcUtils.invalidate();
      } catch (error: unknown) {
        captureException(error, { context: "share-import", fileUri, providerId });
        setSharedImportState({
          status: "error",
          progress: 0,
          message: error instanceof Error ? error.message : "Import failed",
          providerId,
        });
      } finally {
        try {
          deleteSharedFile(fileUri);
        } catch (error: unknown) {
          captureException(error, { context: "share-import-cleanup", fileUri });
        }
      }
    },
    [serverUrl, sessionToken, trpcUtils],
  );

  useEffect(() => {
    if (!sharedFileUri) return;
    if (importedSharedUris.current.has(sharedFileUri)) return;
    importedSharedUris.current.add(sharedFileUri);

    void importFile(sharedFileUri);
  }, [importFile, sharedFileUri]);

  const handleFileImportProvider = useCallback(
    async (providerId: ImportProviderId) => {
      const providerConfig = getFileImportProviderConfig(providerId);
      if (!providerConfig) return;
      try {
        const result = await DocumentPicker.getDocumentAsync({
          copyToCacheDirectory: true,
          multiple: false,
          type: providerConfig.documentTypes,
        });
        if (result.canceled) return;
        const asset = result.assets[0];
        if (!asset) return;
        await importFile(asset.uri, providerConfig.providerId);
      } catch (error: unknown) {
        captureException(error, { context: "file-import-document-picker", providerId });
        setSharedImportState({
          status: "error",
          progress: 0,
          message: error instanceof Error ? error.message : providerConfig.selectionErrorMessage,
          providerId: providerConfig.providerId,
        });
      }
    },
    [importFile],
  );

  const handleSyncProvider = useCallback(
    async (providerId: string, fullSync = false) => {
      setSyncingProviders((prev) => new Set(prev).add(providerId));
      setAnySyncing(true);
      try {
        const result = await syncMutation.mutateAsync({
          providerId,
          sinceDays: fullSync ? undefined : ROUTINE_SYNC_DAYS,
        });
        const providerResult = result.providerResults?.find(
          (entry) => entry.providerId === providerId,
        );
        if (providerResult?.status === "skippedCooldown" || providerResult?.status === "failed") {
          setSyncingProviders((prev) => {
            const next = new Set(prev);
            next.delete(providerId);
            return next;
          });
          setSyncProgress((prev) => ({
            ...prev,
            [providerId]: { message: providerResult.message },
          }));
          if (pollingJobIds.current.size === 0) {
            setAnySyncing(false);
          }
          return;
        }
        const jobId =
          providerResult?.status === "started" || providerResult?.status === "alreadyQueued"
            ? providerResult.jobId
            : result.jobId;
        if (!jobId) return;
        await pollJob(jobId, [providerId]);
      } catch (error: unknown) {
        captureException(error, { context: "sync-provider" });
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
      setSyncAllError(undefined);
      const enabled = (providers.data ?? []).filter(
        (provider) => provider.authorized && !provider.importOnly && !provider.pushOnly,
      );
      const ids = enabled.map((p) => p.id);
      if (ids.length === 0) return;
      setSyncingProviders(new Set(ids));
      setAnySyncing(true);
      try {
        const result = await syncMutation.mutateAsync({
          sinceDays: fullSync ? undefined : ROUTINE_SYNC_DAYS,
        });
        const providerResults = result.providerResults ?? [];
        const providerJobMap = new Map(
          (result.providerJobs ?? []).map((job) => [job.providerId, job.jobId] as const),
        );
        if (providerResults.length > 0) {
          const hasPollableProviderResult = providerResults.some(
            (providerResult) =>
              providerResult.status === "started" || providerResult.status === "alreadyQueued",
          );
          await Promise.all(
            ids.map(async (providerId) => {
              const providerResult = providerResults.find(
                (entry) => entry.providerId === providerId,
              );
              if (
                providerResult?.status === "skippedCooldown" ||
                providerResult?.status === "failed"
              ) {
                setSyncingProviders((prev) => {
                  const next = new Set(prev);
                  next.delete(providerId);
                  return next;
                });
                setSyncProgress((prev) => ({
                  ...prev,
                  [providerId]: { message: providerResult.message },
                }));
                return;
              }
              if (
                providerResult?.status === "started" ||
                providerResult?.status === "alreadyQueued"
              ) {
                await pollJob(providerResult.jobId, [providerId]);
                return;
              }
              setSyncingProviders((prev) => {
                const next = new Set(prev);
                next.delete(providerId);
                return next;
              });
            }),
          );
          if (!hasPollableProviderResult) {
            setAnySyncing(false);
          }
        } else if (providerJobMap.size > 0) {
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
        } else if (result.jobId) {
          await pollJob(result.jobId, ids);
        }
      } catch (error: unknown) {
        captureException(error, { context: "sync-all" });
        if (!isMounted.current) return;
        setSyncAllError(error instanceof Error ? error.message : "Sync failed");
        setSyncingProviders(new Set());
        setAnySyncing(false);
      }
    },
    [syncMutation, providers.data, pollJob],
  );

  const handleConnect = useCallback(
    async (provider: {
      id: string;
      label: string;
      authType: string;
      tokenAuth?: { label: string; instructionsUrl: string } | null;
    }) => {
      switch (provider.authType) {
        case "oauth":
        case "oauth1": {
          if (!sessionToken) break;
          try {
            const handoffCode = await createProviderHandoffCode(
              serverUrl,
              provider.id,
              sessionToken,
            );
            await WebBrowser.openBrowserAsync(
              `${serverUrl}/auth/provider/${provider.id}?code=${encodeURIComponent(handoffCode)}`,
            );
            await trpcUtils.sync.providers.invalidate();
          } catch (error: unknown) {
            captureException(error, { context: "provider-handoff" });
            Alert.alert(
              "Unable to connect provider",
              error instanceof Error ? error.message : "Provider connection failed",
            );
          }
          break;
        }
        case "credential":
          setCredentialAuthProvider({ id: provider.id, name: provider.label });
          break;
        case "token":
          if (provider.tokenAuth) {
            setTokenAuthProvider({
              id: provider.id,
              name: provider.label,
              label: provider.tokenAuth.label,
              instructionsUrl: provider.tokenAuth.instructionsUrl,
            });
          } else {
            const error = new Error(
              `${provider.label} personal-token authentication is unavailable. Refresh and try again.`,
            );
            captureException(error, {
              context: "connect-provider-list",
              providerId: provider.id,
            });
            Alert.alert("Unable to connect provider", error.message);
          }
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

  const providerList: Provider[] = (providers.data ?? []).map((provider) => ({
    id: provider.id,
    label: provider.name,
    enabled: provider.authorized && !provider.importOnly && !provider.pushOnly,
    authStatus: provider.needsReauth
      ? "expired"
      : provider.authorized
        ? "connected"
        : "not_connected",
    authType: provider.authType,
    tokenAuth: provider.tokenAuth,
    lastSyncAt: provider.lastSyncedAt,
    lastSuccessfulSyncAt: provider.lastSuccessfulSyncAt,
    syncFreshness: provider.syncFreshness,
    importOnly: provider.importOnly,
    pushOnly: provider.pushOnly,
  }));
  const statsMap: Record<string, ProviderStats> = {};
  for (const s of stats.data ?? []) {
    statsMap[s.providerId] = s;
  }
  const logList: SyncLog[] = logs.data ?? [];

  const { refreshing, onRefresh } = useRefresh({
    invalidate: () =>
      Promise.all([
        trpcUtils.sync.providers.invalidate(),
        trpcUtils.sync.providerStats.invalidate(),
        trpcUtils.sync.logs.invalidate({ limit: 50 }),
        trpcUtils.processing.status.invalidate(),
        trpcUtils.sync.activeSyncs.invalidate(),
        trpcUtils.sync.activeImports.invalidate(),
      ]).then(() => undefined),
  });

  const isLoading = providers.isLoading;
  const enabledProviders = providerList.filter((p) => p.enabled);
  const appleHealthProvider = appleHealth.model.toProviderCard();
  const activeImportRows = activeImports.error ? [] : (activeImports.data ?? []);
  const activeImportByProvider = new Map(
    activeImportRows.map((activeImport) => [activeImport.providerId, activeImport]),
  );
  const localImportIsActive =
    sharedImportState !== null &&
    sharedImportState.status !== "done" &&
    sharedImportState.status !== "error";
  const appleHealthActiveImport = activeImportByProvider.get("apple_health");
  const appleHealthActiveImportProgress = appleHealthActiveImport
    ? {
        percentage: appleHealthActiveImport.percentage,
        message: appleHealthActiveImport.message,
        failedCount: appleHealthActiveImport.failedCount,
      }
    : undefined;
  const appleHealthLocalImportProgress =
    localImportIsActive && sharedImportState.providerId === "apple-health"
      ? {
          percentage: sharedImportState.progress,
          message: sharedImportState.message,
        }
      : undefined;
  const appleHealthImportProgress =
    appleHealthLocalImportProgress ?? appleHealthActiveImportProgress;

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
      {enabledProviders.length > 0 && (
        <SyncAllControls
          busy={anySyncing}
          errorMessage={syncAllError}
          onRecentSync={() => void handleSyncAll(false)}
          onFullSync={() => void handleSyncAll(true)}
        />
      )}

      <View style={styles.shareInfoCard}>
        <Text style={styles.shareInfoTitle}>Import from Share</Text>
        <Text style={styles.shareInfoDescription}>
          Export a CSV, XML, or ZIP file from Strong, Cronometer, Apple Health, or Garmin and share
          it to Dofek.
        </Text>
        {activeImports.error ? (
          <QueryStatePanel
            variant="error"
            title="Could not load import progress"
            message={getQueryErrorMessage(activeImports.error, "Unable to load import progress.")}
            minHeight={96}
          />
        ) : null}
        {sharedImportState ? (
          <View style={styles.shareImportState}>
            <Text style={styles.shareImportTitle}>
              {sharedImportState.status === "done"
                ? `${importProviderLabel(sharedImportState.providerId)} import complete`
                : `${importProviderLabel(sharedImportState.providerId)} import ${sharedImportState.status}`}
            </Text>
            {sharedImportState.status === "error" ? (
              <Text style={[styles.shareImportMessage, styles.shareImportError]}>
                {sharedImportState.message}
              </Text>
            ) : (
              <OperationProgressBar
                percentage={sharedImportState.progress}
                message={sharedImportState.message}
              />
            )}
          </View>
        ) : null}
      </View>

      {/* Data Sources */}
      <ProcessingStatusWidget
        data={processingStatus.data}
        error={processingStatus.error}
        loading={processingStatus.isLoading}
      />
      <Text style={styles.sectionTitle}>Data Sources</Text>
      {activeSyncs.error ? (
        <QueryStatePanel
          variant="error"
          title="Could not load sync progress"
          message={getQueryErrorMessage(activeSyncs.error, "Unable to load sync progress.")}
          minHeight={96}
        />
      ) : null}
      <FileImportProviderCard
        provider={{
          ...appleHealthProvider,
        }}
        stats={statsMap.apple_health}
        syncing={healthKitSyncing}
        importing={appleHealthImportProgress !== undefined}
        syncProgress={
          appleHealthImportProgress ??
          (healthKitSyncing || healthKitProgress ? { message: healthKitProgress } : undefined)
        }
        onSync={() => handleHealthKitSync()}
        onConnect={handleHealthKitConnect}
        onImportProvider={handleFileImportProvider}
        onPress={() => router.push("/providers/apple_health")}
      />
      {appleHealth.model.shouldShowPermissionBanner() && (
        <TouchableOpacity
          style={styles.permissionBanner}
          onPress={handleHealthKitConnect}
          disabled={healthKitSyncing}
          accessibilityRole="button"
          accessibilityLabel="Review Apple Health permissions"
          accessibilityState={{ busy: healthKitSyncing, disabled: healthKitSyncing }}
        >
          <Text style={styles.permissionBannerText}>
            Apple Health permissions need updating — tap to review
          </Text>
        </TouchableOpacity>
      )}
      {providers.error ? (
        <View style={styles.card}>
          <QueryStatePanel
            variant="error"
            title="Could not load data sources"
            message={getQueryErrorMessage(providers.error, "Failed to load providers.")}
          />
        </View>
      ) : null}
      {stats.error ? (
        <View style={styles.card}>
          <QueryStatePanel
            variant="error"
            title="Could not load provider stats"
            message={getQueryErrorMessage(stats.error, "Failed to load provider stats.")}
          />
        </View>
      ) : null}
      {isLoading && !providers.error ? (
        <QueryStatePanel variant="loading" style={styles.card} />
      ) : null}
      {providerList.map((provider) => {
        const fileImportProviderConfig = getFileImportProviderConfig(provider.id);
        const activeImport = activeImportByProvider.get(provider.id);
        const activeImportProgress = activeImport
          ? {
              percentage: activeImport.percentage,
              message: activeImport.message,
              failedCount: activeImport.failedCount,
            }
          : undefined;
        const localImportProgress =
          localImportIsActive && sharedImportState.providerId === provider.id
            ? {
                percentage: sharedImportState.progress,
                message: sharedImportState.message,
              }
            : undefined;
        const importProgress = localImportProgress ?? activeImportProgress;
        return fileImportProviderConfig ? (
          <FileImportProviderCard
            key={provider.id}
            provider={provider}
            stats={statsMap[provider.id]}
            syncing={syncingProviders.has(provider.id)}
            importing={importProgress !== undefined}
            syncProgress={importProgress ?? syncProgress[provider.id]}
            onSync={() => handleSyncProvider(provider.id)}
            onConnect={() => handleConnect(provider)}
            onImportProvider={handleFileImportProvider}
            onPress={() => router.push(`/providers/${provider.id}`)}
          />
        ) : (
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
        );
      })}

      {/* Sync History */}
      <Text style={[styles.sectionTitle, { marginTop: 24 }]}>Sync History</Text>
      {logs.error ? (
        <View style={styles.card}>
          <QueryStatePanel
            variant="error"
            title={
              logs.data === undefined
                ? "Could not load sync history"
                : "Could not refresh sync history"
            }
            message={getQueryErrorMessage(logs.error, "Failed to load sync history.")}
          />
        </View>
      ) : null}
      {logs.isLoading && logs.data === undefined ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: 12 }} />
      ) : logs.error && logs.data === undefined ? null : logList.length === 0 ? (
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
      {tokenAuthProvider && (
        <TokenAuthModal
          providerId={tokenAuthProvider.id}
          providerName={tokenAuthProvider.name}
          tokenLabel={tokenAuthProvider.label}
          instructionsUrl={tokenAuthProvider.instructionsUrl}
          onClose={() => setTokenAuthProvider(null)}
          onSuccess={() => {
            setTokenAuthProvider(null);
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
