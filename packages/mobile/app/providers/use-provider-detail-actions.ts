import * as WebBrowser from "expo-web-browser";
import { useCallback, useRef, useState } from "react";
import { useAppleHealthProviderModel } from "../../lib/apple-health-provider";
import { useAuth } from "../../lib/auth-context";
import { captureException } from "../../lib/telemetry";
import { trpc } from "../../lib/trpc";

interface ProviderRecord {
  id: string;
  name: string;
  authType: string;
  authorized: boolean;
  importOnly: boolean;
  pushOnly: boolean;
  lastSyncedAt: string | null;
  needsReauth: boolean;
}

export interface DisplayProvider {
  id: string;
  name: string;
  authType: string;
  authorized: boolean;
  importOnly: boolean;
  pushOnly: boolean;
  lastSyncedAt: string | null;
}

interface CredentialAuthProvider {
  id: string;
  name: string;
}

interface ProviderDetailModals {
  credentialAuthProvider: CredentialAuthProvider | null;
  whoopAuthOpen: boolean;
  garminAuthOpen: boolean;
  closeCredentialAuth: () => void;
  closeWhoopAuth: () => void;
  closeGarminAuth: () => void;
  handleCredentialSuccess: () => void;
  handleWhoopSuccess: () => void;
  handleGarminSuccess: () => void;
}

export interface ProviderDetailActionsResult {
  provider: ProviderRecord | undefined;
  displayProvider: DisplayProvider | undefined;
  isLoading: boolean;
  isConnected: boolean;
  primaryActionLabel: "Sync" | "Connect" | "Reconnect";
  isSyncing: boolean;
  syncMessage: string | null;
  syncProgress: number | null;
  shouldShowActions: boolean;
  shouldShowFullSync: boolean;
  shouldShowAppleHealthPermissionBanner: boolean;
  handlePrimaryAction: () => Promise<void>;
  handleFullSync: () => Promise<void>;
  modals: ProviderDetailModals;
}

export function useProviderDetailActions(
  providerId: string | undefined,
): ProviderDetailActionsResult {
  const { serverUrl, sessionToken } = useAuth();
  const trpcUtils = trpc.useUtils();
  const providers = trpc.sync.providers.useQuery();
  const syncMutation = trpc.sync.triggerSync.useMutation();

  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<number | null>(null);
  const [credentialAuthProvider, setCredentialAuthProvider] =
    useState<CredentialAuthProvider | null>(null);
  const [whoopAuthOpen, setWhoopAuthOpen] = useState(false);
  const [garminAuthOpen, setGarminAuthOpen] = useState(false);

  const pollingRef = useRef(false);
  const trpcClient = trpcUtils.client;
  const appleHealth = useAppleHealthProviderModel({
    trpcClient,
    enabled: providerId === "apple_health",
    onAuthorizationError: (error) => {
      captureException(error, { context: "healthkit-permission-check" });
    },
  });

  const provider = (providers.data ?? []).find((currentProvider: ProviderRecord) => {
    return currentProvider.id === providerId;
  });

  const displayProvider =
    providerId === "apple_health" ? appleHealth.model.toDisplayProvider() : provider;

  const isConnected = Boolean(displayProvider?.authorized);
  const needsReauth = Boolean(provider?.needsReauth);

  const invalidateProviderData = useCallback(() => {
    trpcUtils.sync.providers.invalidate();
    trpcUtils.sync.providerStats.invalidate();
    trpcUtils.sync.logs.invalidate();
  }, [trpcUtils]);

  const pollSyncJob = useCallback(
    async (jobId: string) => {
      if (pollingRef.current) return;
      pollingRef.current = true;

      const poll = async (): Promise<void> => {
        let status: Awaited<ReturnType<typeof trpcUtils.sync.syncStatus.fetch>>;
        try {
          status = await trpcUtils.sync.syncStatus.fetch({ jobId }, { staleTime: 0 });
        } catch (error: unknown) {
          captureException(error, { context: "provider-sync-poll" });
          pollingRef.current = false;
          setIsSyncing(false);
          setSyncMessage("Sync failed");
          return;
        }

        if (!status) {
          pollingRef.current = false;
          setIsSyncing(false);
          return;
        }

        setSyncProgress(status.percentage ?? null);
        const providerStatus = providerId ? status.providers[providerId] : null;
        if (providerStatus?.message) {
          setSyncMessage(providerStatus.message);
        }

        if (status.status === "done" || status.status === "error") {
          pollingRef.current = false;
          setIsSyncing(false);
          setSyncMessage(status.status === "done" ? "Sync complete" : "Sync failed");
          invalidateProviderData();
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
        return poll();
      };

      return poll();
    },
    [invalidateProviderData, providerId, trpcUtils],
  );

  const handleHealthKitConnect = useCallback(async () => {
    setIsSyncing(true);
    setSyncProgress(null);
    setSyncMessage("Requesting permissions...");

    try {
      const result = await appleHealth.connect();
      if (!result.granted || result.state.requestStatus === "unavailable") {
        setSyncMessage("HealthKit is unavailable on this device");
      } else {
        setSyncMessage(result.state.isConnected() ? "Connected" : null);
      }

      invalidateProviderData();
    } catch (error: unknown) {
      captureException(error, { context: "healthkit-connect" });
      setSyncMessage(error instanceof Error ? error.message : "Failed to connect to Apple Health");
    } finally {
      setIsSyncing(false);
    }
  }, [appleHealth, invalidateProviderData]);

  const handleConnect = useCallback(async () => {
    if (!displayProvider || isSyncing) return;

    if (displayProvider.id === "apple_health") {
      await handleHealthKitConnect();
      return;
    }

    switch (displayProvider.authType) {
      case "oauth":
      case "oauth1":
        if (!sessionToken) return;
        await WebBrowser.openBrowserAsync(
          `${serverUrl}/auth/provider/${displayProvider.id}?session=${encodeURIComponent(sessionToken)}`,
        );
        trpcUtils.sync.providers.invalidate();
        break;
      case "credential":
        setCredentialAuthProvider({ id: displayProvider.id, name: displayProvider.name });
        break;
      case "custom:whoop":
        setWhoopAuthOpen(true);
        break;
      case "custom:garmin":
        setGarminAuthOpen(true);
        break;
    }
  }, [displayProvider, handleHealthKitConnect, isSyncing, serverUrl, sessionToken, trpcUtils]);

  const handleSync = useCallback(
    async (sinceDays: number | undefined) => {
      if (!providerId || isSyncing) return;

      setIsSyncing(true);
      setSyncMessage("Starting sync...");
      setSyncProgress(0);

      try {
        if (providerId === "apple_health") {
          const result = await appleHealth.sync({
            syncRangeDays: sinceDays ?? null,
            onProgress: setSyncMessage,
          });

          setSyncMessage(`Done — ${result.inserted} records synced`);
          setSyncProgress(null);
          setIsSyncing(false);
          invalidateProviderData();
          return;
        }

        const result = await syncMutation.mutateAsync({
          providerId,
          sinceDays,
        });
        const providerResult = result.providerResults?.find(
          (entry) => entry.providerId === providerId,
        );
        if (providerResult?.status === "skippedCooldown" || providerResult?.status === "failed") {
          setIsSyncing(false);
          setSyncProgress(null);
          setSyncMessage(providerResult.message);
          return;
        }
        const jobId =
          providerResult?.status === "started" || providerResult?.status === "alreadyQueued"
            ? providerResult.jobId
            : result.jobId;
        if (!jobId) return;
        await pollSyncJob(jobId);
      } catch (error: unknown) {
        captureException(error, {
          context: providerId === "apple_health" ? "healthkit-manual-sync" : "provider-sync-start",
        });
        setIsSyncing(false);
        setSyncMessage("Failed to start sync");
      }
    },
    [appleHealth, invalidateProviderData, isSyncing, pollSyncJob, providerId, syncMutation],
  );

  const handlePrimaryAction = useCallback(async () => {
    if (isConnected && !needsReauth) {
      await handleSync(7);
      return;
    }

    await handleConnect();
  }, [handleConnect, handleSync, isConnected, needsReauth]);

  const handleFullSync = useCallback(async () => {
    await handleSync(undefined);
  }, [handleSync]);

  const closeCredentialAuth = useCallback(() => {
    setCredentialAuthProvider(null);
  }, []);

  const closeWhoopAuth = useCallback(() => {
    setWhoopAuthOpen(false);
  }, []);

  const closeGarminAuth = useCallback(() => {
    setGarminAuthOpen(false);
  }, []);

  const handleCredentialSuccess = useCallback(() => {
    setCredentialAuthProvider(null);
    trpcUtils.sync.providers.invalidate();
  }, [trpcUtils]);

  const handleWhoopSuccess = useCallback(() => {
    setWhoopAuthOpen(false);
    trpcUtils.sync.providers.invalidate();
  }, [trpcUtils]);

  const handleGarminSuccess = useCallback(() => {
    setGarminAuthOpen(false);
    trpcUtils.sync.providers.invalidate();
  }, [trpcUtils]);

  return {
    provider,
    displayProvider,
    isLoading: providers.isLoading,
    isConnected,
    primaryActionLabel: needsReauth ? "Reconnect" : isConnected ? "Sync" : "Connect",
    isSyncing,
    syncMessage,
    syncProgress,
    shouldShowActions: Boolean(
      displayProvider && !displayProvider.importOnly && !displayProvider.pushOnly,
    ),
    shouldShowFullSync: isConnected && !needsReauth && displayProvider?.pushOnly !== true,
    shouldShowAppleHealthPermissionBanner:
      providerId === "apple_health" && appleHealth.model.shouldShowPermissionBanner(),
    handlePrimaryAction,
    handleFullSync,
    modals: {
      credentialAuthProvider,
      whoopAuthOpen,
      garminAuthOpen,
      closeCredentialAuth,
      closeWhoopAuth,
      closeGarminAuth,
      handleCredentialSuccess,
      handleWhoopSuccess,
      handleGarminSuccess,
    },
  };
}
