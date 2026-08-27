import { groupProviderEntries, providerFamily } from "@dofek/providers/provider-catalog";
import { ROUTINE_SYNC_DAYS } from "@dofek/providers/sync-actions";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { useProcessingStatus } from "../hooks/useProcessingStatus.ts";
import { pollSyncJob } from "../lib/poll-sync-job.ts";
import { locallyReportedErrorMeta } from "../lib/query-client.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";
import {
  CredentialAuthModal,
  GarminAuthModal,
  TokenAuthModal,
  WhoopAuthModal,
} from "./DataSourcesAuthModals.tsx";
import type { ProviderState, SyncProviderSummary } from "./DataSourcesSyncTypes.ts";
import { FileImportProviderCard } from "./FileImportProviderCard.tsx";
import {
  appleHealthFileImportConfig,
  type fileImportConfigs,
  getFileImportConfig,
} from "./file-import-configs.ts";
import { ProcessingStatusWidget } from "./ProcessingStatusWidget.tsx";
import { ProviderFamilyCard } from "./ProviderFamilyCard.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";
import { SyncAllControls } from "./SyncAllControls.tsx";
import { SyncProviderCard } from "./SyncProviderCard.tsx";

const oauthBroadcastMessage = z.object({
  type: z.literal("complete"),
  providerId: z.string().optional(),
});

const oauthPostMessage = z.object({
  type: z.literal("oauth-complete"),
  providerId: z.string().optional(),
});

const providerRegionClassName =
  "h-80 space-y-3 overflow-y-auto overscroll-contain rounded-lg pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:h-96 lg:h-[28rem]";
const providerGridClassName = "grid gap-3 sm:grid-cols-2 lg:grid-cols-3";

export function DataSourcesPanel() {
  const providers = trpc.sync.providers.useQuery();
  const stats = trpc.sync.providerStats.useQuery();
  const logs = trpc.sync.logs.useQuery({ limit: 100 });
  const processingStatus = useProcessingStatus({ datasets: ["providers"] });
  const syncMutation = trpc.sync.triggerSync.useMutation({
    meta: locallyReportedErrorMeta,
  });
  const trpcUtils = trpc.useUtils();

  const [providerStates, setProviderStates] = useState<Record<string, ProviderState>>({});
  const [syncAllMode, setSyncAllMode] = useState<"sync" | "full" | null>(null);
  const [syncAllError, setSyncAllError] = useState<string>();

  // Resume polling for any active sync jobs (e.g. navigated away and back)
  const activeSyncs = trpc.sync.activeSyncs.useQuery(undefined, { staleTime: 0 });
  const activeImports = trpc.sync.activeImports.useQuery(undefined, { staleTime: 0 });
  const resumedJobIds = useRef(new Set<string>());
  const pollAbortControllers = useRef(new Set<AbortController>());
  const isMounted = useRef(false);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
      for (const controller of pollAbortControllers.current) {
        controller.abort();
      }
      pollAbortControllers.current.clear();
    };
  }, []);

  // Auth modal state
  const [whoopAuthOpen, setWhoopAuthOpen] = useState(false);
  const [garminAuthOpen, setGarminAuthOpen] = useState(false);
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

  const updateState = useCallback(
    (id: string, state: ProviderState) => setProviderStates((prev) => ({ ...prev, [id]: state })),
    [],
  );

  const doPollSyncJob = useCallback(
    async (jobId: string, providerIds: string[]) => {
      const controller = new AbortController();
      if (isMounted.current) {
        pollAbortControllers.current.add(controller);
      } else {
        controller.abort();
      }
      try {
        await pollSyncJob({
          jobId,
          providerIds,
          fetchStatus: (id) =>
            trpcUtils.sync.syncStatus.fetch(
              { jobId: id },
              { staleTime: 0, meta: locallyReportedErrorMeta },
            ),
          updateState,
          onComplete: () => {
            trpcUtils.invalidate();
          },
          onError: (error) => {
            const providerId = providerIds.length === 1 ? providerIds[0] : undefined;
            captureException(
              error,
              providerId
                ? { operation: "sync.syncStatus", providerId }
                : { operation: "sync.syncStatus" },
            );
          },
          signal: controller.signal,
        });
      } finally {
        pollAbortControllers.current.delete(controller);
      }
    },
    [trpcUtils, updateState],
  );

  const handleSync = useCallback(
    async (providerId: string, fullSync = false) => {
      updateState(providerId, { status: "syncing" });
      try {
        const result = await syncMutation.mutateAsync({
          providerId,
          sinceDays: fullSync ? undefined : ROUTINE_SYNC_DAYS,
        });
        const providerResult = result.providerResults?.find(
          (entry) => entry.providerId === providerId,
        );
        if (providerResult?.status === "skippedCooldown") {
          updateState(providerId, { status: "done", message: providerResult.message });
          return;
        }
        if (providerResult?.status === "failed") {
          updateState(providerId, { status: "error", message: providerResult.message });
          return;
        }
        const jobId =
          providerResult?.status === "started" || providerResult?.status === "alreadyQueued"
            ? providerResult.jobId
            : result.jobId;
        if (!jobId) return;
        await doPollSyncJob(jobId, [providerId]);
      } catch (err: unknown) {
        captureException(err, {
          operation: "sync.triggerSync",
          providerId,
        });
        updateState(providerId, {
          status: "error",
          message: err instanceof Error ? err.message : "Sync failed",
        });
      }
    },
    [syncMutation, updateState, doPollSyncJob],
  );

  const handleSyncAll = useCallback(
    async (fullSync = false) => {
      setSyncAllError(undefined);
      setSyncAllMode(fullSync ? "full" : "sync");
      const enabled = (providers.data ?? []).filter(
        (p) => p.authorized && !p.importOnly && !p.pushOnly,
      );
      const ids = enabled.map((p) => p.id);
      if (ids.length === 0) {
        setSyncAllMode(null);
        return;
      }
      for (const p of enabled) {
        updateState(p.id, { status: "syncing" });
      }
      try {
        const result = await syncMutation.mutateAsync({
          sinceDays: fullSync ? undefined : ROUTINE_SYNC_DAYS,
        });
        const providerResults = result.providerResults;
        await Promise.all(
          ids.map(async (providerId) => {
            const providerResult = providerResults.find((entry) => entry.providerId === providerId);
            if (providerResult?.status === "skippedCooldown") {
              updateState(providerId, { status: "done", message: providerResult.message });
              return;
            }
            if (providerResult?.status === "failed") {
              updateState(providerId, { status: "error", message: providerResult.message });
              return;
            }
            if (
              providerResult?.status === "started" ||
              providerResult?.status === "alreadyQueued"
            ) {
              await doPollSyncJob(providerResult.jobId, [providerId]);
              return;
            }
            updateState(providerId, { status: "error", message: "Failed to start sync job" });
          }),
        );
      } catch (err: unknown) {
        captureException(err, { operation: "sync.triggerSync" });
        const message = err instanceof Error ? err.message : "Sync failed";
        setSyncAllError(message);
        for (const p of enabled) {
          updateState(p.id, {
            status: "error",
            message,
          });
        }
      } finally {
        setSyncAllMode(null);
      }
    },
    [providers.data, syncMutation, updateState, doPollSyncJob],
  );

  // Pre-compute provider stats.
  const statsByProvider = useMemo(
    () => new Map((stats.data ?? []).map((s) => [s.providerId, s])),
    [stats.data],
  );
  const importLogsByProvider = useMemo(() => {
    const map = new Map<string, NonNullable<typeof logs.data>>();
    for (const row of logs.data ?? []) {
      const providerLogs = map.get(row.providerId) ?? [];
      providerLogs.push(row);
      map.set(row.providerId, providerLogs);
    }
    return map;
  }, [logs.data]);

  const allProviders = providers.data ?? [];
  const activeImportByProvider = new Map(
    (activeImports.data ?? []).map((activeImport) => [activeImport.providerId, activeImport]),
  );
  const enabledSyncable = allProviders.filter((p) => !p.importOnly && !p.pushOnly);
  const syncAllBusy =
    syncMutation.isPending ||
    syncAllMode !== null ||
    Object.values(providerStates).some((state) => state.status === "syncing") ||
    (activeSyncs.data ?? []).some(
      (activeSync) => activeSync.status === "running" || activeSync.status === "queued",
    );

  // Resume polling for sync jobs that were already running when the page loaded
  useEffect(() => {
    if (!activeSyncs.data) return;
    for (const activeJob of activeSyncs.data) {
      if (activeJob.status !== "running" && activeJob.status !== "queued") continue;
      if (resumedJobIds.current.has(activeJob.jobId)) continue;
      resumedJobIds.current.add(activeJob.jobId);

      // Set provider states to reflect the current progress
      const providerIds = Object.keys(activeJob.providers);
      for (const [pid, providerStatus] of Object.entries(activeJob.providers)) {
        if (providerStatus.status === "running" || providerStatus.status === "pending") {
          updateState(pid, { status: "syncing", message: providerStatus.message });
        } else if (providerStatus.status === "done") {
          updateState(pid, { status: "done", message: providerStatus.message });
        } else if (providerStatus.status === "error") {
          updateState(pid, { status: "error", message: providerStatus.message });
        }
      }

      // Start polling this job
      doPollSyncJob(activeJob.jobId, providerIds);
    }
  }, [activeSyncs.data, updateState, doPollSyncJob]);

  // Listen for OAuth completion from the popup via BroadcastChannel + postMessage.
  // Both channels may fire for the same event, so deduplicate with a timestamp.
  const lastOAuthHandledAt = useRef(0);
  useEffect(() => {
    const onOAuthComplete = (providerId?: string) => {
      const now = Date.now();
      if (now - lastOAuthHandledAt.current < 2000) return;
      lastOAuthHandledAt.current = now;

      trpcUtils.sync.providers.invalidate();
      // Auto-trigger a full sync for the newly connected provider
      if (providerId) {
        handleSync(providerId, true);
      }
    };
    // Primary: BroadcastChannel (same-origin, works even if window.opener is null)
    let channel: BroadcastChannel | undefined;
    try {
      channel = new BroadcastChannel("oauth-complete");
      channel.onmessage = (event: MessageEvent) => {
        const parsed = oauthBroadcastMessage.safeParse(event.data);
        if (parsed.success) {
          onOAuthComplete(parsed.data.providerId);
        }
      };
    } catch {
      // BroadcastChannel not supported — rely on postMessage fallback
    }
    // Fallback: window.postMessage from the popup via window.opener
    const onMessage = (event: MessageEvent) => {
      // Validate origin to prevent accepting messages from malicious scripts
      if (event.origin !== window.location.origin) return;
      const parsed = oauthPostMessage.safeParse(event.data);
      if (parsed.success) {
        onOAuthComplete(parsed.data.providerId);
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      channel?.close();
      window.removeEventListener("message", onMessage);
    };
  }, [trpcUtils, handleSync]);

  const handleProviderClick = useCallback(
    (provider: SyncProviderSummary) => {
      if (provider.authorized && !provider.needsReauth && !provider.pushOnly) {
        handleSync(provider.id);
        return;
      }
      if (provider.pushOnly) {
        return;
      }
      switch (provider.authType) {
        case "oauth":
        case "oauth1":
          window.open(`/auth/provider/${provider.id}`, "_blank");
          break;
        case "credential":
          setCredentialAuthProvider({ id: provider.id, name: provider.name });
          break;
        case "token":
          if (provider.tokenAuth) {
            setTokenAuthProvider({
              id: provider.id,
              name: provider.name,
              label: provider.tokenAuth.label,
              instructionsUrl: provider.tokenAuth.instructionsUrl,
            });
          } else {
            const error = new Error(
              `${provider.name} personal-token authentication is unavailable. Refresh and try again.`,
            );
            captureException(error, {
              operation: "connect-provider",
              providerId: provider.id,
            });
            updateState(provider.id, { status: "error", message: error.message });
          }
          break;
        case "custom:whoop":
          setWhoopAuthOpen(true);
          break;
        case "custom:garmin":
          setGarminAuthOpen(true);
          break;
        default:
          handleSync(provider.id);
      }
    },
    [handleSync, updateState],
  );

  // Build unified list: server providers + Apple Health (file-import-only, not registered on server)
  const unifiedProviders: Array<
    | { kind: "sync"; provider: (typeof allProviders)[number] }
    | { kind: "import"; id: string; config: (typeof fileImportConfigs)[string] }
  > = [];

  // Add Apple Health first (always available, not in server provider list)
  // ID must match the database provider_id ("apple_health") so stats/logs look up correctly
  unifiedProviders.push({
    kind: "import",
    id: "apple_health",
    config: appleHealthFileImportConfig,
  });

  for (const p of allProviders) {
    const importConfig = getFileImportConfig(p.id);
    if (importConfig) {
      unifiedProviders.push({ kind: "import", id: p.id, config: importConfig });
    } else {
      unifiedProviders.push({ kind: "sync", provider: p });
    }
  }
  const providerGroups = groupProviderEntries(
    unifiedProviders.map((entry) => ({
      ...entry,
      id: entry.kind === "import" ? entry.id : entry.provider.id,
    })),
  );

  const renderProviderEntry = (entry: (typeof unifiedProviders)[number]) => {
    if (entry.kind === "import") {
      const providerStats = statsByProvider.get(entry.id);
      const recentLogs = (importLogsByProvider.get(entry.id) ?? []).slice(0, 5);
      return (
        <FileImportProviderCard
          providerId={entry.id}
          {...entry.config}
          stats={providerStats}
          recentLogs={recentLogs}
          activeImport={activeImportByProvider.get(entry.id)}
        />
      );
    }

    const provider = entry.provider;
    const state = providerStates[provider.id] ?? { status: "idle" };
    const needsAuth =
      !provider.pushOnly &&
      provider.authType !== "none" &&
      provider.authType !== "file-import" &&
      !provider.authorized;
    const needsReauth = provider.needsReauth === true;
    const providerStats = statsByProvider.get(provider.id);

    return (
      <SyncProviderCard
        provider={provider}
        state={state}
        needsAuth={needsAuth}
        needsReauth={needsReauth}
        pushOnly={provider.pushOnly === true}
        stats={providerStats}
        recentLogs={provider.recentLogs ?? []}
        onSync={() => handleProviderClick(provider)}
      />
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex min-h-20 items-start justify-between gap-4">
        <h3 className="text-sm font-medium text-foreground">Data Sources</h3>
        {enabledSyncable.length > 1 && (
          <SyncAllControls
            busy={syncAllBusy}
            errorMessage={syncAllError}
            onRecentSync={() => void handleSyncAll()}
            onFullSync={() => void handleSyncAll(true)}
          />
        )}
      </div>

      <section
        aria-label="Available data sources"
        aria-busy={providers.isLoading || processingStatus.isLoading}
        className={providerRegionClassName}
      >
        {activeSyncs.error ? (
          <p role="alert" className="text-sm text-red-400">
            {activeSyncs.error.message}
          </p>
        ) : null}

        <ProcessingStatusWidget
          data={processingStatus.data}
          error={processingStatus.error}
          loading={processingStatus.isLoading}
        />

        {providers.error ? <QueryStatePanel error={providers.error} height={72} /> : null}
        {stats.error ? <QueryStatePanel error={stats.error} height={72} /> : null}
        {logs.error ? <QueryStatePanel error={logs.error} height={72} /> : null}

        <div className={providerGridClassName}>
          {providers.isLoading
            ? ["skeleton-1", "skeleton-2", "skeleton-3"].map((id) => (
                <div key={id} className="h-24 rounded-lg bg-skeleton animate-pulse" />
              ))
            : providerGroups.map((group) =>
                group.kind === "provider" ? (
                  <div key={group.provider.id}>{renderProviderEntry(group.provider)}</div>
                ) : (
                  <ProviderFamilyCard
                    key={group.family.id}
                    familyLabel={group.family.label}
                    methods={group.providers.map((provider) => ({
                      id: provider.id,
                      label: providerFamily(provider.id)?.methodLabel ?? provider.id,
                      content: <div key={provider.id}>{renderProviderEntry(provider)}</div>,
                    }))}
                  />
                ),
              )}
        </div>
      </section>

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

      {/* Generic Credential Auth Modal */}
      {credentialAuthProvider && (
        <CredentialAuthModal
          providerId={credentialAuthProvider.id}
          providerName={credentialAuthProvider.name}
          description={
            credentialAuthProvider.id === "amazfit-zepp"
              ? "Signing in will sign you out of the Zepp app on your phone. " +
                "Dofek can only pull historical data — new data won\u2019t sync until you sign back into the Zepp app, " +
                "which will disconnect Dofek."
              : undefined
          }
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
    </div>
  );
}
