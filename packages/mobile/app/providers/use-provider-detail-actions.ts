import { formatDateYmd } from "@dofek/format/format";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppleHealthProviderModel } from "../../lib/apple-health-provider";
import { createProviderHandoffCode } from "../../lib/auth";
import { useAuth } from "../../lib/auth-context";
import {
  HEALTHKIT_DATABASE_INACCESSIBLE_MESSAGE,
  isHealthKitDatabaseInaccessible,
} from "../../lib/health-kit-errors";
import { captureException } from "../../lib/telemetry";
import { trpc } from "../../lib/trpc";

interface ProviderRecord {
  id: string;
  name: string;
  authType: string;
  tokenAuth?: { label: string; instructionsUrl: string } | null;
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
  tokenAuth?: { label: string; instructionsUrl: string } | null;
  authorized: boolean;
  importOnly: boolean;
  pushOnly: boolean;
  lastSyncedAt: string | null;
}

interface CredentialAuthProvider {
  id: string;
  name: string;
}

interface TokenAuthProvider extends CredentialAuthProvider {
  label: string;
  instructionsUrl: string;
}

export interface ProviderDetailModals {
  credentialAuthProvider: CredentialAuthProvider | null;
  tokenAuthProvider: TokenAuthProvider | null;
  whoopAuthOpen: boolean;
  garminAuthOpen: boolean;
  closeCredentialAuth: () => void;
  closeTokenAuth: () => void;
  closeWhoopAuth: () => void;
  closeGarminAuth: () => void;
  handleCredentialSuccess: () => void;
  handleTokenSuccess: () => void;
  handleWhoopSuccess: () => void;
  handleGarminSuccess: () => void;
}

export interface ProviderDetailActionsResult {
  provider: ProviderRecord | undefined;
  displayProvider: DisplayProvider | undefined;
  isLoading: boolean;
  inventoryError: unknown;
  isConnected: boolean;
  primaryActionLabel: "Sync" | "Connect" | "Reconnect";
  isSyncing: boolean;
  syncMessage: string | null;
  syncProgress: number | null;
  syncDateRange: ProviderSyncDateRange | null;
  shouldShowActions: boolean;
  shouldShowFullSync: boolean;
  shouldShowAppleHealthPermissionBanner: boolean;
  handlePrimaryAction: () => Promise<void>;
  handleFullSync: () => Promise<void>;
  modals: ProviderDetailModals;
}

export interface ProviderSyncDateRange {
  sinceDate: string;
  untilDate: string;
  onSinceDateChange: (date: string) => void;
  onUntilDateChange: (date: string) => void;
}

interface SyncWindowInput {
  sinceDays?: number;
  sinceDate?: string;
  untilDate?: string;
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
  const [rangeSinceDate, setRangeSinceDate] = useState(() => {
    const start = new Date();
    start.setDate(start.getDate() - 7);
    return formatDateYmd(start);
  });
  const [rangeUntilDate, setRangeUntilDate] = useState(() => formatDateYmd());
  const [credentialAuthProvider, setCredentialAuthProvider] =
    useState<CredentialAuthProvider | null>(null);
  const [tokenAuthProvider, setTokenAuthProvider] = useState<TokenAuthProvider | null>(null);
  const [whoopAuthOpen, setWhoopAuthOpen] = useState(false);
  const [garminAuthOpen, setGarminAuthOpen] = useState(false);

  const isMounted = useRef(false);
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

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
      pollingRef.current = false;
    };
  }, []);

  const invalidateProviderData = useCallback(() => {
    trpcUtils.sync.providers.invalidate();
    trpcUtils.sync.providerStats.invalidate();
    trpcUtils.sync.logs.invalidate();
    if (providerId) {
      trpcUtils.providerDetail.availableDataTypes.invalidate({ providerId });
      trpcUtils.providerDetail.logs.invalidate({ providerId });
      trpcUtils.providerDetail.records.invalidate({ providerId });
    }
  }, [providerId, trpcUtils]);

  const pollSyncJob = useCallback(
    async (jobId: string) => {
      if (pollingRef.current) return;
      pollingRef.current = true;

      const poll = async (): Promise<void> => {
        if (!isMounted.current) return;
        let status: Awaited<ReturnType<typeof trpcUtils.sync.syncStatus.fetch>>;
        try {
          status = await trpcUtils.sync.syncStatus.fetch({ jobId }, { staleTime: 0 });
        } catch (error: unknown) {
          captureException(error, { context: "provider-sync-poll" });
          if (!isMounted.current) return;
          setSyncMessage(
            error instanceof Error ? error.message : "Sync status is temporarily unavailable.",
          );
          await new Promise((resolve) => setTimeout(resolve, 1000));
          if (!isMounted.current) return;
          return poll();
        }

        if (!isMounted.current) return;
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

        if (status.status === "completed" || status.status === "failed") {
          pollingRef.current = false;
          setIsSyncing(false);
          setSyncMessage(status.status === "completed" ? "Sync complete" : "Sync failed");
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
      if (result.state.requestStatus === "unavailable") {
        setSyncMessage("Apple Health is unavailable on this device");
      } else if (!result.granted) {
        setSyncMessage("Apple Health permissions were not granted");
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
      case "oauth1": {
        if (!sessionToken) return;
        try {
          const handoffCode = await createProviderHandoffCode(
            serverUrl,
            displayProvider.id,
            sessionToken,
          );
          await WebBrowser.openBrowserAsync(
            `${serverUrl}/auth/provider/${displayProvider.id}?code=${encodeURIComponent(handoffCode)}`,
          );
          await trpcUtils.sync.providers.invalidate();
        } catch (error: unknown) {
          captureException(error, { context: "connect-provider-detail" });
          setSyncMessage(error instanceof Error ? error.message : "Provider connection failed");
        }
        break;
      }
      case "credential":
        setCredentialAuthProvider({ id: displayProvider.id, name: displayProvider.name });
        break;
      case "token":
        if (displayProvider.tokenAuth) {
          setTokenAuthProvider({
            id: displayProvider.id,
            name: displayProvider.name,
            label: displayProvider.tokenAuth.label,
            instructionsUrl: displayProvider.tokenAuth.instructionsUrl,
          });
        } else {
          const error = new Error(
            `${displayProvider.name} personal-token authentication is unavailable. Refresh and try again.`,
          );
          captureException(error, {
            context: "connect-provider-detail",
            providerId: displayProvider.id,
          });
          setSyncMessage(error.message);
        }
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
    async (syncWindow: SyncWindowInput) => {
      if (!providerId || isSyncing) return;

      setIsSyncing(true);
      setSyncMessage("Starting sync...");
      setSyncProgress(0);

      try {
        if (providerId === "apple_health") {
          const result = await appleHealth.sync({
            syncRangeDays: syncWindow.sinceDays ?? null,
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
          ...syncWindow,
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
        setIsSyncing(false);
        if (!isHealthKitDatabaseInaccessible(error)) {
          captureException(error, {
            context:
              providerId === "apple_health" ? "healthkit-manual-sync" : "provider-sync-start",
          });
          setSyncMessage("Failed to start sync");
          return;
        }
        setSyncMessage(HEALTHKIT_DATABASE_INACCESSIBLE_MESSAGE);
      }
    },
    [appleHealth, invalidateProviderData, isSyncing, pollSyncJob, providerId, syncMutation],
  );

  const handlePrimaryAction = useCallback(async () => {
    if (isConnected && !needsReauth) {
      if (providerId === "whoop") {
        if (rangeSinceDate > rangeUntilDate) {
          setSyncMessage('"From" date must be on or before "To" date');
          return;
        }
        await handleSync({
          sinceDate: rangeSinceDate,
          untilDate: rangeUntilDate,
        });
        return;
      }
      await handleSync({ sinceDays: 7 });
      return;
    }

    await handleConnect();
  }, [
    handleConnect,
    handleSync,
    isConnected,
    needsReauth,
    providerId,
    rangeSinceDate,
    rangeUntilDate,
  ]);

  const handleFullSync = useCallback(async () => {
    await handleSync({ sinceDays: undefined });
  }, [handleSync]);

  const handleRangeSinceDateChange = useCallback(
    (date: string) => {
      setRangeSinceDate(date);
      if (date <= rangeUntilDate) {
        setSyncMessage(null);
      }
    },
    [rangeUntilDate],
  );

  const handleRangeUntilDateChange = useCallback(
    (date: string) => {
      setRangeUntilDate(date);
      if (rangeSinceDate <= date) {
        setSyncMessage(null);
      }
    },
    [rangeSinceDate],
  );

  const closeCredentialAuth = useCallback(() => {
    setCredentialAuthProvider(null);
  }, []);

  const closeTokenAuth = useCallback(() => {
    setTokenAuthProvider(null);
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

  const handleTokenSuccess = useCallback(() => {
    setTokenAuthProvider(null);
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
    inventoryError: providers.error,
    isConnected,
    primaryActionLabel: needsReauth ? "Reconnect" : isConnected ? "Sync" : "Connect",
    isSyncing,
    syncMessage,
    syncProgress,
    syncDateRange:
      providerId === "whoop" && isConnected && !needsReauth
        ? {
            sinceDate: rangeSinceDate,
            untilDate: rangeUntilDate,
            onSinceDateChange: handleRangeSinceDateChange,
            onUntilDateChange: handleRangeUntilDateChange,
          }
        : null,
    shouldShowActions: Boolean(
      displayProvider && !displayProvider.importOnly && !displayProvider.pushOnly,
    ),
    shouldShowFullSync:
      isConnected &&
      !needsReauth &&
      displayProvider?.pushOnly !== true &&
      displayProvider?.id !== "whoop",
    shouldShowAppleHealthPermissionBanner:
      providerId === "apple_health" && appleHealth.model.shouldShowPermissionBanner(),
    handlePrimaryAction,
    handleFullSync,
    modals: {
      credentialAuthProvider,
      tokenAuthProvider,
      whoopAuthOpen,
      garminAuthOpen,
      closeCredentialAuth,
      closeTokenAuth,
      closeWhoopAuth,
      closeGarminAuth,
      handleCredentialSuccess,
      handleTokenSuccess,
      handleWhoopSuccess,
      handleGarminSuccess,
    },
  };
}
