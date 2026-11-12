import { formatDateYmd } from "@dofek/format/format";
import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import {
  isCloudPushProvider,
  type ProviderManualConnectionMetadata,
} from "@dofek/providers/provider-connection";
import type { ProviderSyncHistory } from "@dofek/providers/sync-card-summary";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppleHealthProviderModel } from "../../lib/apple-health-provider";
import { createProviderHandoffCode } from "../../lib/auth";
import { useAuth } from "../../lib/auth-context";
import { useHealthKitManualSync } from "../../lib/health-kit-manual-sync-context";
import { ManualHealthKitSyncInterruptedError } from "../../lib/health-kit-sync-types";
import { captureException } from "../../lib/telemetry";
import { trpc } from "../../lib/trpc";
import { appleHealthManualSyncPresentation } from "./provider-card";

interface ProviderRecord extends ProviderSyncHistory {
  id: string;
  name: string;
  authType: string;
  tokenAuth?: ProviderManualConnectionMetadata | null;
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
  tokenAuth?: ProviderManualConnectionMetadata | null;
  authorized: boolean;
  importOnly: boolean;
  pushOnly: boolean;
  lastSyncedAt: string | null;
}

interface CredentialAuthProvider {
  id: string;
  name: string;
}

interface TokenAuthProvider extends CredentialAuthProvider, ProviderManualConnectionMetadata {}

export interface ProviderDetailModals {
  credentialAuthProvider: CredentialAuthProvider | null;
  tokenAuthProvider: TokenAuthProvider | null;
  whoopAuthOpen: boolean;
  closeCredentialAuth: () => void;
  closeTokenAuth: () => void;
  closeWhoopAuth: () => void;
  handleCredentialSuccess: () => void;
  handleTokenSuccess: () => void;
  handleWhoopSuccess: () => void;
}

export interface ProviderDetailActionsResult {
  provider: ProviderRecord | undefined;
  displayProvider: DisplayProvider | undefined;
  isLoading: boolean;
  inventoryError: unknown;
  isConnected: boolean;
  primaryActionLabel: "Sync" | "Connect" | "Reconnect" | "Resume";
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

  const [localIsSyncing, setLocalIsSyncing] = useState(false);
  const [localSyncMessage, setLocalSyncMessage] = useState<string | null>(null);
  const [localSyncProgress, setLocalSyncProgress] = useState<number | null>(null);
  const [manualActionError, setManualActionError] = useState<string | null>(null);
  const { controller: manualSyncController, state: manualSyncState } = useHealthKitManualSync();
  const manualSyncControllerRef = useRef(manualSyncController);
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

  const isMounted = useRef(false);
  const pollingRef = useRef(false);
  const appleHealth = useAppleHealthProviderModel({
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
  const isAppleHealth = providerId === "apple_health";
  const appleHealthPresentation = appleHealthManualSyncPresentation(
    manualSyncState,
    manualActionError,
    localSyncMessage,
  );
  const isSyncing = localIsSyncing || (isAppleHealth && appleHealthPresentation.isRunning);
  const syncMessage = isAppleHealth ? appleHealthPresentation.detailMessage : localSyncMessage;
  const syncProgress = isAppleHealth ? appleHealthPresentation.percentage : localSyncProgress;

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
      pollingRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (manualSyncControllerRef.current !== manualSyncController) {
      manualSyncControllerRef.current = manualSyncController;
      setLocalSyncMessage(null);
      setLocalSyncProgress(null);
      setManualActionError(null);
    }
  }, [manualSyncController]);

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
          setLocalSyncMessage(
            userFacingErrorMessage(error, "Sync status is temporarily unavailable."),
          );
          await new Promise((resolve) => setTimeout(resolve, 1000));
          if (!isMounted.current) return;
          return poll();
        }

        if (!isMounted.current) return;
        if (!status) {
          pollingRef.current = false;
          setLocalIsSyncing(false);
          return;
        }

        setLocalSyncProgress(status.percentage ?? null);
        const providerStatus = providerId ? status.providers[providerId] : null;
        if (providerStatus?.message) {
          setLocalSyncMessage(providerStatus.message);
        }

        if (status.status === "completed" || status.status === "failed") {
          pollingRef.current = false;
          setLocalIsSyncing(false);
          setLocalSyncMessage(status.status === "completed" ? "Sync complete" : "Sync failed");
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
    setLocalIsSyncing(true);
    setLocalSyncProgress(null);
    setLocalSyncMessage("Requesting permissions...");

    try {
      const result = await appleHealth.connect();
      if (result.state.requestStatus === "unavailable") {
        setLocalSyncMessage("Apple Health is unavailable on this device");
      } else if (!result.granted) {
        setLocalSyncMessage("Apple Health permissions were not granted");
      } else {
        setLocalSyncMessage(result.state.isConnected() ? "Connected" : null);
      }

      invalidateProviderData();
    } catch (error: unknown) {
      captureException(error, { context: "healthkit-connect" });
      setLocalSyncMessage(userFacingErrorMessage(error, "Failed to connect to Apple Health"));
    } finally {
      setLocalIsSyncing(false);
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
          setLocalSyncMessage(userFacingErrorMessage(error, "Provider connection failed"));
        }
        break;
      }
      case "credential":
        setCredentialAuthProvider({ id: displayProvider.id, name: displayProvider.name });
        break;
      case "public-profile":
      case "token":
        if (displayProvider.tokenAuth) {
          setTokenAuthProvider({
            kind: displayProvider.tokenAuth.kind,
            id: displayProvider.id,
            name: displayProvider.name,
            label: displayProvider.tokenAuth.label,
            instructionsUrl: displayProvider.tokenAuth.instructionsUrl,
            description: displayProvider.tokenAuth.description,
          });
        } else {
          const error = new Error(
            `${displayProvider.name} personal-token authentication is unavailable. Refresh and try again.`,
          );
          captureException(error, {
            context: "connect-provider-detail",
            providerId: displayProvider.id,
          });
          setLocalSyncMessage(userFacingErrorMessage(error));
        }
        break;
      case "custom:whoop":
        setWhoopAuthOpen(true);
        break;
    }
  }, [displayProvider, handleHealthKitConnect, isSyncing, serverUrl, sessionToken, trpcUtils]);

  const handleSync = useCallback(
    async (syncWindow: SyncWindowInput) => {
      if (!providerId || isSyncing) return;

      const isAppleHealthSync = providerId === "apple_health";
      if (!isAppleHealthSync) setLocalIsSyncing(true);
      setLocalSyncMessage(null);
      setManualActionError(null);
      setLocalSyncProgress(isAppleHealthSync ? null : 0);

      try {
        if (providerId === "apple_health") {
          const result = await appleHealth.sync({
            syncRangeDays: syncWindow.sinceDays ?? null,
          });

          setLocalSyncMessage(`Done — ${result.inserted} records synced`);
          setLocalSyncProgress(null);
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
          setLocalIsSyncing(false);
          setLocalSyncProgress(null);
          setLocalSyncMessage(providerResult.message);
          return;
        }
        const jobId =
          providerResult?.status === "started" || providerResult?.status === "alreadyQueued"
            ? providerResult.jobId
            : result.jobId;
        if (!jobId) return;
        await pollSyncJob(jobId);
      } catch (error: unknown) {
        if (providerId !== "apple_health") setLocalIsSyncing(false);
        if (error instanceof ManualHealthKitSyncInterruptedError) {
          setLocalSyncProgress(null);
          return;
        }
        captureException(error, {
          context: providerId === "apple_health" ? "healthkit-manual-sync" : "provider-sync-start",
        });
        if (providerId === "apple_health" && !manualSyncController) {
          setManualActionError(userFacingErrorMessage(error, "Apple Health sync failed"));
        } else if (providerId !== "apple_health") {
          setLocalSyncMessage(userFacingErrorMessage(error, "Sync failed"));
        }
      }
    },
    [
      appleHealth,
      invalidateProviderData,
      isSyncing,
      manualSyncController,
      pollSyncJob,
      providerId,
      syncMutation,
    ],
  );

  const handleResume = useCallback(async () => {
    if (manualSyncState.status === "running") return;
    if (!manualSyncController) {
      setManualActionError("Apple Health sync is unavailable for this account. Sign in and retry.");
      return;
    }
    setManualActionError(null);
    try {
      await manualSyncController.resume();
      invalidateProviderData();
    } catch (error: unknown) {
      if (error instanceof ManualHealthKitSyncInterruptedError) return;
      captureException(error, { context: "healthkit-manual-sync" });
      if (manualSyncController.getSnapshot().status !== "error") {
        setManualActionError(userFacingErrorMessage(error, "Apple Health sync failed"));
      }
    }
  }, [invalidateProviderData, manualSyncController, manualSyncState.status]);

  const handlePrimaryAction = useCallback(async () => {
    if (isAppleHealth && manualSyncState.status === "paused") {
      await handleResume();
      return;
    }
    if (isConnected && !needsReauth && !displayProvider?.pushOnly) {
      if (providerId === "whoop") {
        if (rangeSinceDate > rangeUntilDate) {
          setLocalSyncMessage('"From" date must be on or before "To" date');
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
    displayProvider?.pushOnly,
    handleConnect,
    handleResume,
    handleSync,
    isConnected,
    isAppleHealth,
    manualSyncState.status,
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
        setLocalSyncMessage(null);
      }
    },
    [rangeUntilDate],
  );

  const handleRangeUntilDateChange = useCallback(
    (date: string) => {
      setRangeUntilDate(date);
      if (rangeSinceDate <= date) {
        setLocalSyncMessage(null);
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

  return {
    provider,
    displayProvider,
    isLoading: providers.isLoading,
    inventoryError: providers.error,
    isConnected,
    primaryActionLabel:
      isAppleHealth && manualSyncState.status === "paused"
        ? "Resume"
        : needsReauth || (isConnected && displayProvider?.pushOnly)
          ? "Reconnect"
          : isConnected
            ? "Sync"
            : "Connect",
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
      displayProvider &&
        !displayProvider.importOnly &&
        (!displayProvider.pushOnly ||
          (isCloudPushProvider(displayProvider) && (!isConnected || needsReauth))),
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
      closeCredentialAuth,
      closeTokenAuth,
      closeWhoopAuth,
      handleCredentialSuccess,
      handleTokenSuccess,
      handleWhoopSuccess,
    },
  };
}
