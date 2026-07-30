import { formatDateYmd, formatRelativeTime } from "@dofek/format/format";
import { providerHealth } from "@dofek/providers/provider-health";
import { Link, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  CredentialAuthModal,
  GarminAuthModal,
  TokenAuthModal,
  WhoopAuthModal,
} from "../components/DataSourcesAuthModals.tsx";
import { FileImportProviderCard } from "../components/FileImportProviderCard.tsx";
import { getFileImportConfig } from "../components/file-import-configs.ts";
import { OperationProgressBar } from "../components/OperationProgressBar.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { ProcessingStatusWidget } from "../components/ProcessingStatusWidget.tsx";
import { ProviderLogo } from "../components/ProviderLogo.tsx";
import { ProviderStatsBreakdown } from "../components/ProviderStatsBreakdown.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { useProcessingStatus } from "../hooks/useProcessingStatus.ts";
import { pollSyncJob } from "../lib/poll-sync-job.ts";
import { locallyReportedErrorMeta } from "../lib/query-client.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";
import { ProviderDangerZone } from "./ProviderDangerZone.tsx";
import { RecordsBrowser, SyncHistory } from "./provider-detail-data.tsx";
import { WhoopWearLocationPicker } from "./WhoopWearLocationPicker.tsx";

const oauthBroadcastMessage = z.object({
  type: z.literal("complete"),
  providerId: z.string().optional(),
});

const oauthPostMessage = z.object({
  type: z.literal("oauth-complete"),
  providerId: z.string().optional(),
});

function formatProviderName(id: string): string {
  return id
    .split(/[_-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function hasValidDateInput(value: string | Date | null | undefined): value is string | Date {
  if (!value) return false;
  return !Number.isNaN(new Date(value).getTime());
}

export function ProviderDetailPage() {
  const { id: providerId } = useParams({ from: "/providers/$id" });

  const providers = trpc.sync.providers.useQuery();
  const stats = trpc.sync.providerStats.useQuery();
  const processingStatus = useProcessingStatus({ providerId });
  const trpcUtils = trpc.useUtils();

  const provider = (providers.data ?? []).find((p) => p.id === providerId);
  const providerStats = (stats.data ?? []).find((s) => s.providerId === providerId);
  const importConfig = getFileImportConfig(providerId);
  const hasFileImportConfig = importConfig !== undefined;
  const activeImports = trpc.sync.activeImports.useQuery(undefined, {
    enabled: hasFileImportConfig,
    staleTime: 0,
  });
  const activeImport = (activeImports.data ?? []).find(
    (importJob) => importJob.providerId === providerId,
  );
  const pushOnly = provider?.pushOnly === true;
  const health = provider
    ? providerHealth({
        authorized: provider.authorized,
        needsReauth: provider.needsReauth,
        requiresAuthorization: provider.authType !== "none",
      })
    : null;
  const lastSyncedRelative = hasValidDateInput(provider?.lastSyncedAt)
    ? formatRelativeTime(provider.lastSyncedAt)
    : null;

  // Sync state
  const syncMutation = trpc.sync.triggerSync.useMutation({
    meta: locallyReportedErrorMeta,
  });
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "done" | "error">("idle");
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncPercentage, setSyncPercentage] = useState<number | undefined>(undefined);
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

  // Date range sync
  const [sinceDays, setSinceDays] = useState("30");
  const [rangeStartDate, setRangeStartDate] = useState(() => {
    const start = new Date();
    start.setDate(start.getDate() - 7);
    return formatDateYmd(start);
  });
  const [rangeEndDate, setRangeEndDate] = useState(() => formatDateYmd(new Date()));

  const runSyncJob = useCallback(
    async (input: { sinceDays?: number; sinceDate?: string; untilDate?: string }) => {
      setSyncStatus("syncing");
      setSyncMessage(null);
      setSyncPercentage(undefined);
      try {
        const result = await syncMutation.mutateAsync({
          providerId,
          ...input,
        });
        const providerResult = result.providerResults?.find(
          (entry) => entry.providerId === providerId,
        );
        if (providerResult?.status === "skippedCooldown") {
          setSyncStatus("done");
          setSyncMessage(providerResult.message);
          return;
        }
        if (providerResult?.status === "failed") {
          setSyncStatus("error");
          setSyncMessage(providerResult.message);
          return;
        }
        const jobId =
          providerResult?.status === "started" || providerResult?.status === "alreadyQueued"
            ? providerResult.jobId
            : result.jobId;
        if (!jobId) return;
        const controller = new AbortController();
        if (isMounted.current) {
          pollAbortControllers.current.add(controller);
        } else {
          controller.abort();
        }
        try {
          await pollSyncJob({
            jobId,
            providerIds: [providerId],
            fetchStatus: (id) =>
              trpcUtils.sync.syncStatus.fetch(
                { jobId: id },
                { staleTime: 0, meta: locallyReportedErrorMeta },
              ),
            updateState: (_id, state) => {
              setSyncPercentage(state.percentage);
              if (state.message) setSyncMessage(state.message);
              if (state.status === "done") {
                setSyncStatus("done");
                setSyncPercentage(undefined);
                setSyncMessage("Sync complete");
              } else if (state.status === "error") {
                setSyncStatus("error");
                setSyncPercentage(undefined);
                setSyncMessage(state.message ?? "Sync failed");
              }
            },
            onComplete: () => {
              trpcUtils.processing.status.invalidate();
              trpcUtils.sync.providers.invalidate();
              trpcUtils.sync.providerStats.invalidate();
              trpcUtils.providerDetail.availableDataTypes.invalidate({ providerId });
              trpcUtils.providerDetail.logs.invalidate();
              trpcUtils.providerDetail.records.invalidate();
            },
            onError: (error) => {
              captureException(error, {
                operation: "sync.syncStatus",
                providerId,
              });
            },
            signal: controller.signal,
          });
        } finally {
          pollAbortControllers.current.delete(controller);
        }
      } catch (err: unknown) {
        captureException(err, {
          operation: "sync.triggerSync",
          providerId,
        });
        setSyncStatus("error");
        setSyncPercentage(undefined);
        setSyncMessage(err instanceof Error ? err.message : "Sync failed");
      }
    },
    [providerId, syncMutation, trpcUtils],
  );

  const handleSync = useCallback(
    async (fullSync = false, customSinceDays?: number) => {
      if (fullSync) {
        await runSyncJob({});
        return;
      }
      await runSyncJob({ sinceDays: customSinceDays ?? 7 });
    },
    [runSyncJob],
  );

  const handleSyncDateRange = useCallback(async () => {
    if (!rangeStartDate || !rangeEndDate) return;
    if (rangeStartDate > rangeEndDate) {
      setSyncStatus("error");
      setSyncMessage('"From" date must be on or before "To" date');
      return;
    }
    await runSyncJob({ sinceDate: rangeStartDate, untilDate: rangeEndDate });
  }, [rangeEndDate, rangeStartDate, runSyncJob]);
  const [reconnectModal, setReconnectModal] = useState<
    "credential" | "garmin" | "token" | "whoop" | null
  >(null);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  const handleReauthorize = useCallback(() => {
    window.open(`/auth/provider/${providerId}`, "_blank");
  }, [providerId]);
  const handleReconnect = useCallback(() => {
    setReconnectError(null);
    switch (provider?.authType) {
      case "oauth":
      case "oauth1":
        handleReauthorize();
        return;
      case "credential":
        setReconnectModal("credential");
        return;
      case "token": {
        if (provider.tokenAuth) {
          setReconnectModal("token");
          return;
        }
        const error = new Error(
          `${provider.name} personal-token authentication is unavailable. Refresh and try again.`,
        );
        captureException(error, {
          operation: "reconnect-provider",
          providerId: provider.id,
        });
        setReconnectError(error.message);
        return;
      }
      case "custom:garmin":
        setReconnectModal("garmin");
        return;
      case "custom:whoop":
        setReconnectModal("whoop");
        return;
    }
  }, [handleReauthorize, provider]);
  const handleReconnectSuccess = useCallback(() => {
    setReconnectModal(null);
    setReconnectError(null);
    trpcUtils.sync.providers.invalidate();
    trpcUtils.processing.status.invalidate({ providerId });
  }, [providerId, trpcUtils]);

  // Listen for OAuth completion (re-authorize flow)
  const lastOAuthHandledAt = useRef(0);
  useEffect(() => {
    const onOAuthComplete = () => {
      const now = Date.now();
      if (now - lastOAuthHandledAt.current < 2000) return;
      lastOAuthHandledAt.current = now;
      trpcUtils.sync.providers.invalidate();
    };
    let channel: BroadcastChannel | undefined;
    try {
      channel = new BroadcastChannel("oauth-complete");
      channel.onmessage = (event: MessageEvent) => {
        const parsed = oauthBroadcastMessage.safeParse(event.data);
        if (parsed.success) onOAuthComplete();
      };
    } catch {
      /* BroadcastChannel not supported */
    }
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const parsed = oauthPostMessage.safeParse(event.data);
      if (parsed.success) onOAuthComplete();
    };
    window.addEventListener("message", onMessage);
    return () => {
      channel?.close();
      window.removeEventListener("message", onMessage);
    };
  }, [trpcUtils]);

  if (providers.isLoading && providers.data === undefined) {
    return (
      <PageLayout>
        <div className="h-32 rounded-lg bg-skeleton animate-pulse" />
      </PageLayout>
    );
  }

  if (providers.error && providers.data === undefined) {
    return (
      <PageLayout>
        <QueryStatePanel error={providers.error} />
      </PageLayout>
    );
  }

  if (!provider && !hasFileImportConfig) {
    return (
      <PageLayout>
        <section className="space-y-2">
          <h1 className="text-xl font-semibold">Provider not found</h1>
          <p className="text-sm text-subtle">
            This provider is unavailable. Return to Data Sources to choose another.
          </p>
          <Link to="/providers" className="text-sm text-accent hover:underline">
            Back to Data Sources
          </Link>
        </section>
      </PageLayout>
    );
  }

  return (
    <PageLayout>
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs text-subtle">
        <Link to="/providers" className="hover:text-foreground">
          Providers
        </Link>
        <span>/</span>
        <span className="text-foreground">{provider?.name ?? formatProviderName(providerId)}</span>
      </div>

      {providers.error ? (
        <section className="space-y-2">
          <p className="text-sm font-medium text-foreground">Could not refresh provider details.</p>
          <QueryStatePanel error={providers.error} height={96} />
        </section>
      ) : null}

      {stats.error ? <QueryStatePanel error={stats.error} height={96} /> : null}

      {/* Provider header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ProviderLogo provider={providerId} size={32} />
          <div>
            <h1 className="text-xl font-semibold">
              {provider?.name ?? formatProviderName(providerId)}
            </h1>
            {provider && (
              <div className="flex items-center gap-2 mt-0.5">
                {provider.pushOnly ? (
                  <>
                    <span className="text-xs text-subtle">Mobile sync</span>
                    {lastSyncedRelative && (
                      <span className="text-xs text-dim">Last received: {lastSyncedRelative}</span>
                    )}
                  </>
                ) : provider.importOnly ? (
                  <span className="text-xs text-subtle">Import only</span>
                ) : (
                  <dl className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <div className="flex items-center gap-1">
                      <dt className="text-dim">Connection</dt>
                      <dd
                        className={
                          health?.connection.status === "healthy"
                            ? "text-emerald-400"
                            : "text-subtle"
                        }
                      >
                        {health?.connection.label}
                      </dd>
                    </div>
                    <div className="flex items-center gap-1">
                      <dt className="text-dim">Authorization</dt>
                      <dd
                        className={
                          health?.authorization.status === "warning"
                            ? "text-amber-400"
                            : health?.authorization.status === "healthy"
                              ? "text-emerald-400"
                              : "text-subtle"
                        }
                      >
                        {health?.authorization.label}
                      </dd>
                    </div>
                  </dl>
                )}
                {!provider.pushOnly && !provider.importOnly && lastSyncedRelative && (
                  <span className="text-xs text-dim">Last sync: {lastSyncedRelative}</span>
                )}
              </div>
            )}
          </div>
        </div>
        {provider && health?.requiresReconnect && !provider.importOnly && !provider.pushOnly ? (
          <div className="flex flex-col items-end gap-2">
            <button
              type="button"
              onClick={handleReconnect}
              className="rounded bg-amber-500 px-3 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-amber-400"
              aria-label={`Reconnect ${provider.name}`}
            >
              Reconnect {provider.name}
            </button>
            {reconnectError ? (
              <p role="alert" className="max-w-sm text-right text-xs text-red-400">
                {reconnectError}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <ProcessingStatusWidget
        data={processingStatus.data}
        error={processingStatus.error}
        loading={processingStatus.isLoading}
        contextLabel={`${formatProviderName(providerId)} data status`}
        alwaysVisible
      />

      {importConfig && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-foreground">Import</h2>
          <FileImportProviderCard
            providerId={providerId}
            {...importConfig}
            stats={providerStats}
            showDetailsLink={false}
            activeImport={activeImport}
          />
        </section>
      )}

      {pushOnly && (
        <section className="card p-4 space-y-3">
          <div>
            <h2 className="text-sm font-medium text-foreground">Mobile sync</h2>
            <p className="text-xs text-subtle mt-1">
              {provider.description ? `${provider.description} ` : null}Open the Dofek app on your
              phone with your WHOOP nearby to stream RR intervals and orientation data.
            </p>
          </div>
        </section>
      )}

      {/* Sync controls */}
      {provider?.authorized === true && !hasFileImportConfig && !pushOnly && (
        <section className="card p-4 space-y-3">
          <h2 className="text-sm font-medium text-foreground">
            {health?.requiresReconnect ? "Connection Controls" : "Sync Controls"}
          </h2>
          <div className="flex flex-wrap items-end gap-3">
            {!health?.requiresReconnect ? (
              <>
                {providerId !== "whoop" ? (
                  <>
                    <button
                      type="button"
                      onClick={() => handleSync(false)}
                      disabled={syncStatus === "syncing"}
                      className="px-3 py-1.5 text-xs rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                    >
                      {syncStatus === "syncing" ? "Syncing..." : "Sync Last 7 Days"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSync(true)}
                      disabled={syncStatus === "syncing"}
                      className="px-3 py-1.5 text-xs rounded bg-accent/10 text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors"
                    >
                      Full Sync
                    </button>
                    <div className="flex items-end gap-1.5">
                      <div>
                        <label htmlFor="since-days" className="block text-xs text-subtle mb-1">
                          Days back
                        </label>
                        <input
                          id="since-days"
                          type="number"
                          min="1"
                          max="3650"
                          value={sinceDays}
                          onChange={(event) => setSinceDays(event.target.value)}
                          className="w-20 px-2 py-1.5 text-xs bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-border-strong"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => handleSync(false, Number(sinceDays))}
                        disabled={syncStatus === "syncing" || !sinceDays}
                        className="px-3 py-1.5 text-xs rounded bg-accent/10 text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors"
                      >
                        Sync Range
                      </button>
                    </div>
                  </>
                ) : null}
                <div className="flex flex-wrap items-end gap-1.5">
                  <div>
                    <label htmlFor="range-start-date" className="block text-xs text-subtle mb-1">
                      From
                    </label>
                    <input
                      id="range-start-date"
                      type="date"
                      value={rangeStartDate}
                      max={providerId === "whoop" ? rangeEndDate : undefined}
                      onChange={(event) => setRangeStartDate(event.target.value)}
                      className="px-2 py-1.5 text-xs bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-border-strong"
                    />
                  </div>
                  <div>
                    <label htmlFor="range-end-date" className="block text-xs text-subtle mb-1">
                      To
                    </label>
                    <input
                      id="range-end-date"
                      type="date"
                      value={rangeEndDate}
                      min={providerId === "whoop" ? rangeStartDate : undefined}
                      onChange={(event) => setRangeEndDate(event.target.value)}
                      className="px-2 py-1.5 text-xs bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-border-strong"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => handleSyncDateRange()}
                    disabled={syncStatus === "syncing" || !rangeStartDate || !rangeEndDate}
                    className={
                      providerId === "whoop"
                        ? "px-3 py-1.5 text-xs rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                        : "px-3 py-1.5 text-xs rounded bg-accent/10 text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors"
                    }
                  >
                    {providerId === "whoop"
                      ? syncStatus === "syncing"
                        ? "Syncing..."
                        : "Sync"
                      : "Sync Dates"}
                  </button>
                </div>
              </>
            ) : null}
            <div className="ml-auto flex items-center gap-3">
              {!health?.requiresReconnect &&
                (provider?.authType === "oauth" || provider?.authType === "oauth1") &&
                provider.authorized && (
                  <button
                    type="button"
                    onClick={handleReauthorize}
                    className="px-3 py-1.5 text-xs rounded bg-accent/10 text-foreground hover:bg-surface-hover transition-colors"
                  >
                    Re-authorize
                  </button>
                )}
            </div>
          </div>
          {syncStatus === "syncing" ? (
            <OperationProgressBar
              percentage={syncPercentage}
              message={syncMessage ?? "Syncing provider data..."}
            />
          ) : syncMessage ? (
            <div className={`text-xs ${syncStatus === "error" ? "text-red-400" : "text-accent"}`}>
              {syncMessage}
            </div>
          ) : null}
        </section>
      )}

      {provider && reconnectModal === "credential" ? (
        <CredentialAuthModal
          providerId={provider.id}
          providerName={provider.name}
          onClose={() => setReconnectModal(null)}
          onSuccess={handleReconnectSuccess}
        />
      ) : null}
      {reconnectModal === "garmin" ? (
        <GarminAuthModal
          onClose={() => setReconnectModal(null)}
          onSuccess={handleReconnectSuccess}
        />
      ) : null}
      {provider?.tokenAuth && reconnectModal === "token" ? (
        <TokenAuthModal
          providerId={provider.id}
          providerName={provider.name}
          tokenLabel={provider.tokenAuth.label}
          instructionsUrl={provider.tokenAuth.instructionsUrl}
          onClose={() => setReconnectModal(null)}
          onSuccess={handleReconnectSuccess}
        />
      ) : null}
      {reconnectModal === "whoop" ? (
        <WhoopAuthModal
          onClose={() => setReconnectModal(null)}
          onSuccess={handleReconnectSuccess}
        />
      ) : null}

      {/* WHOOP wear location */}
      {providerId === "whoop" && <WhoopWearLocationPicker />}

      {/* Stats overview */}
      {providerStats && <ProviderStatsBreakdown stats={providerStats} variant="full" />}

      {/* Sync history */}
      {!pushOnly && (
        <SyncHistory
          key={`sync-history-${providerId}`}
          providerId={providerId}
          providerName={provider?.name ?? formatProviderName(providerId)}
        />
      )}

      {/* Records browser */}
      <RecordsBrowser
        key={`records-browser-${providerId}`}
        providerId={providerId}
        stats={providerStats}
      />

      <ProviderDangerZone
        canDisconnect={Boolean(provider?.authorized)}
        providerId={providerId}
        providerName={provider?.name ?? formatProviderName(providerId)}
        additionalOperations={
          syncStatus === "syncing"
            ? [
                {
                  id: "provider-sync",
                  label: "Provider sync",
                  percentage: syncPercentage,
                  message: syncMessage ?? "Syncing provider data...",
                },
              ]
            : []
        }
      />
    </PageLayout>
  );
}
