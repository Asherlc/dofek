import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { useProcessingStatus } from "../hooks/useProcessingStatus.ts";
import { pollSyncJob } from "../lib/poll-sync-job.ts";
import { trpc } from "../lib/trpc.ts";
import { CredentialAuthModal, GarminAuthModal, WhoopAuthModal } from "./DataSourcesAuthModals.tsx";
import type { ProviderState, SyncProviderSummary } from "./DataSourcesSyncTypes.ts";
import { FileImportProviderCard } from "./FileImportProviderCard.tsx";
import {
  appleHealthFileImportConfig,
  type fileImportConfigs,
  getFileImportConfig,
} from "./file-import-configs.ts";
import { ProcessingStatusWidget } from "./ProcessingStatusWidget.tsx";
import { SyncProviderCard } from "./SyncProviderCard.tsx";

const oauthBroadcastMessage = z.object({
  type: z.literal("complete"),
  providerId: z.string().optional(),
});

const oauthPostMessage = z.object({
  type: z.literal("oauth-complete"),
  providerId: z.string().optional(),
});

export function DataSourcesPanel() {
  const providers = trpc.sync.providers.useQuery();
  const stats = trpc.sync.providerStats.useQuery();
  const logs = trpc.sync.logs.useQuery({ limit: 100 });
  const processingStatus = useProcessingStatus({});
  const syncMutation = trpc.sync.triggerSync.useMutation();
  const trpcUtils = trpc.useUtils();

  const [providerStates, setProviderStates] = useState<Record<string, ProviderState>>({});
  const [syncAllMode, setSyncAllMode] = useState<"sync" | "full" | null>(null);

  // Resume polling for any active sync jobs (e.g. navigated away and back)
  const activeSyncs = trpc.sync.activeSyncs.useQuery(undefined, { staleTime: 0 });
  const activeImports = trpc.sync.activeImports.useQuery(undefined, { staleTime: 0 });
  const resumedJobIds = useRef(new Set<string>());

  // Auth modal state
  const [whoopAuthOpen, setWhoopAuthOpen] = useState(false);
  const [garminAuthOpen, setGarminAuthOpen] = useState(false);
  const [credentialAuthProvider, setCredentialAuthProvider] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const updateState = useCallback(
    (id: string, state: ProviderState) => setProviderStates((prev) => ({ ...prev, [id]: state })),
    [],
  );

  const doPollSyncJob = useCallback(
    (jobId: string, providerIds: string[]) =>
      pollSyncJob({
        jobId,
        providerIds,
        fetchStatus: (id) => trpcUtils.sync.syncStatus.fetch({ jobId: id }, { staleTime: 0 }),
        updateState,
        onComplete: () => {
          trpcUtils.invalidate();
        },
      }),
    [trpcUtils, updateState],
  );

  const handleSync = useCallback(
    async (providerId: string, fullSync = false) => {
      updateState(providerId, { status: "syncing" });
      try {
        const result = await syncMutation.mutateAsync({
          providerId,
          sinceDays: fullSync ? undefined : 7,
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
          sinceDays: fullSync ? undefined : 7,
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
        for (const p of enabled) {
          updateState(p.id, {
            status: "error",
            message: err instanceof Error ? err.message : "Sync failed",
          });
        }
      } finally {
        setSyncAllMode(null);
      }
    },
    [providers.data, syncMutation, updateState, doPollSyncJob],
  );

  // Pre-compute stats and logs maps
  const statsByProvider = useMemo(
    () => new Map((stats.data ?? []).map((s) => [s.providerId, s])),
    [stats.data],
  );

  const syncRows: Array<{
    id: string;
    providerId: string;
    dataType: string;
    status: string;
    recordCount: number | null;
    errorMessage: string | null;
    authFailureReason: string | null;
    durationMs: number | null;
    syncedAt: string;
  }> = logs.data ?? [];

  const logsByProvider = useMemo(() => {
    const map = new Map<string, typeof syncRows>();
    for (const row of syncRows) {
      let arr = map.get(row.providerId);
      if (!arr) {
        arr = [];
        map.set(row.providerId, arr);
      }
      arr.push(row);
    }
    return map;
  }, [syncRows]);

  const allProviders = providers.data ?? [];
  const activeImportByProvider = new Map(
    (activeImports.data ?? []).map((activeImport) => [activeImport.providerId, activeImport]),
  );
  const enabledSyncable = allProviders.filter((p) => !p.importOnly && !p.pushOnly);

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
    (p: SyncProviderSummary, fullSync = false) => {
      if (p.authorized && !p.needsReauth && !p.pushOnly) {
        handleSync(p.id, fullSync);
        return;
      }
      if (p.pushOnly) {
        return;
      }
      switch (p.authType) {
        case "oauth":
        case "oauth1":
          window.open(`/auth/provider/${p.id}`, "_blank");
          break;
        case "credential":
          setCredentialAuthProvider({ id: p.id, name: p.name });
          break;
        case "custom:whoop":
          setWhoopAuthOpen(true);
          break;
        case "custom:garmin":
          setGarminAuthOpen(true);
          break;
        default:
          handleSync(p.id, fullSync);
      }
    },
    [handleSync],
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">Data Sources</h3>
        {enabledSyncable.length > 1 && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => handleSyncAll()}
              disabled={syncMutation.isPending}
              className={`text-xs px-3 py-1 rounded transition-colors ${
                syncAllMode === "sync"
                  ? "bg-emerald-600 text-white"
                  : "bg-accent/10 text-foreground hover:bg-surface-hover disabled:opacity-50"
              }`}
            >
              {syncAllMode === "sync" ? "Syncing..." : "Sync All"}
            </button>
            <button
              type="button"
              onClick={() => handleSyncAll(true)}
              disabled={syncMutation.isPending}
              className={`text-xs px-3 py-1 rounded transition-colors ${
                syncAllMode === "full"
                  ? "bg-emerald-600 text-white"
                  : "bg-accent/10 text-muted hover:bg-surface-hover disabled:opacity-50"
              }`}
            >
              {syncAllMode === "full" ? "Full Syncing..." : "Full Sync All"}
            </button>
          </div>
        )}
      </div>

      <ProcessingStatusWidget
        data={processingStatus.data}
        error={processingStatus.error}
        loading={processingStatus.isLoading}
      />

      {providers.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {["skeleton-1", "skeleton-2", "skeleton-3"].map((id) => (
            <div key={id} className="h-24 rounded-lg bg-skeleton animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {unifiedProviders.map((entry) => {
            if (entry.kind === "import") {
              const providerStats = statsByProvider.get(entry.id);
              const recentLogs = (logsByProvider.get(entry.id) ?? []).slice(0, 5);
              return (
                <FileImportProviderCard
                  key={entry.id}
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
            const recentLogs = (logsByProvider.get(provider.id) ?? []).slice(0, 5);

            return (
              <SyncProviderCard
                key={provider.id}
                provider={provider}
                state={state}
                needsAuth={needsAuth}
                needsReauth={needsReauth}
                pushOnly={provider.pushOnly === true}
                stats={providerStats}
                recentLogs={recentLogs}
                onSync={() => handleProviderClick(provider)}
                onFullSync={() => handleProviderClick(provider, true)}
              />
            );
          })}
        </div>
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
    </div>
  );
}
