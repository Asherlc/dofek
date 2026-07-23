import {
  formatDateYmd,
  formatDurationSeconds,
  formatRelativeTime,
  formatTime,
} from "@dofek/format/format";
import { DATA_TYPE_LABELS, type ProviderStats } from "@dofek/providers/provider-stats";
import { Link, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { FileImportProviderCard } from "../components/FileImportProviderCard.tsx";
import { getFileImportConfig } from "../components/file-import-configs.ts";
import { OperationProgressBar } from "../components/OperationProgressBar.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { ProcessingStatusWidget } from "../components/ProcessingStatusWidget.tsx";
import { ProviderDisconnectControl } from "../components/ProviderDisconnectControl.tsx";
import { ProviderLogo } from "../components/ProviderLogo.tsx";
import { ProviderStatsBreakdown } from "../components/ProviderStatsBreakdown.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { useProcessingStatus } from "../hooks/useProcessingStatus.ts";
import { pollSyncJob } from "../lib/poll-sync-job.ts";
import { toFilterOptions } from "../lib/provider-detail-filter-options.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";
import { ProviderDataDeleteControl } from "./ProviderDataDeleteControl.tsx";
import {
  pruneEmptyFilters,
  RecordFiltersGrid,
  TableFilterRow,
  useDebouncedFilters,
} from "./ProviderDetailFilters.tsx";
import { formatCellValue, formatColumnName } from "./provider-detail-format.ts";
import { RecordDetailModal } from "./RecordDetailModal.tsx";
import { WhoopWearLocationPicker } from "./WhoopWearLocationPicker.tsx";

const oauthBroadcastMessage = z.object({
  type: z.literal("complete"),
  providerId: z.string().optional(),
});

const oauthPostMessage = z.object({
  type: z.literal("oauth-complete"),
  providerId: z.string().optional(),
});

type DataType = (typeof DATA_TYPE_LABELS)[number]["key"];

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
  const lastSyncedRelative = hasValidDateInput(provider?.lastSyncedAt)
    ? formatRelativeTime(provider.lastSyncedAt)
    : null;

  // Sync state
  const syncMutation = trpc.sync.triggerSync.useMutation();
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "done" | "error">("idle");
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncPercentage, setSyncPercentage] = useState<number | undefined>(undefined);

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
        await pollSyncJob({
          jobId,
          providerIds: [providerId],
          fetchStatus: (id) => trpcUtils.sync.syncStatus.fetch({ jobId: id }, { staleTime: 0 }),
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
        });
      } catch (err: unknown) {
        captureException(err, { context: "sync-provider" });
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
  // Disconnect
  const disconnectMutation = trpc.providerDetail.disconnect.useMutation();
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);

  const handleReauthorize = useCallback(() => {
    window.open(`/auth/provider/${providerId}`, "_blank");
  }, [providerId]);

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

  const handleDisconnect = useCallback(async () => {
    await disconnectMutation.mutateAsync({ providerId });
    trpcUtils.sync.providers.invalidate();
    trpcUtils.sync.providerStats.invalidate();
    setShowDisconnectConfirm(false);
  }, [providerId, disconnectMutation, trpcUtils]);

  if (providers.isLoading) {
    return (
      <PageLayout>
        <div className="h-32 rounded-lg bg-skeleton animate-pulse" />
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
                ) : provider.authorized ? (
                  <span className="text-xs text-emerald-400">Connected</span>
                ) : (
                  <span className="text-xs text-subtle">Not connected</span>
                )}
                {!provider.pushOnly && !provider.importOnly && lastSyncedRelative && (
                  <span className="text-xs text-dim">Last sync: {lastSyncedRelative}</span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <ProcessingStatusWidget
        data={processingStatus.data}
        error={processingStatus.error}
        loading={processingStatus.isLoading}
        contextLabel={`${formatProviderName(providerId)} data status`}
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
          <ProviderDisconnectControl
            canDisconnect={Boolean(provider?.authorized)}
            showConfirm={showDisconnectConfirm}
            isPending={disconnectMutation.isPending}
            onOpenConfirm={() => setShowDisconnectConfirm(true)}
            onConfirm={handleDisconnect}
            onCancel={() => setShowDisconnectConfirm(false)}
          />
        </section>
      )}

      {/* Sync controls */}
      {!hasFileImportConfig && !pushOnly && (
        <section className="card p-4 space-y-3">
          <h2 className="text-sm font-medium text-foreground">Sync Controls</h2>
          <div className="flex flex-wrap items-end gap-3">
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
                  onChange={(e) => setSinceDays(e.target.value)}
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
            <div className="flex items-end gap-1.5">
              <div>
                <label htmlFor="range-start-date" className="block text-xs text-subtle mb-1">
                  From
                </label>
                <input
                  id="range-start-date"
                  type="date"
                  value={rangeStartDate}
                  onChange={(e) => setRangeStartDate(e.target.value)}
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
                  onChange={(e) => setRangeEndDate(e.target.value)}
                  className="px-2 py-1.5 text-xs bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-border-strong"
                />
              </div>
              <button
                type="button"
                onClick={() => handleSyncDateRange()}
                disabled={syncStatus === "syncing" || !rangeStartDate || !rangeEndDate}
                className="px-3 py-1.5 text-xs rounded bg-accent/10 text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors"
              >
                Sync Dates
              </button>
            </div>
            <div className="ml-auto flex items-center gap-3">
              {provider?.authType === "oauth" && provider.authorized && (
                <button
                  type="button"
                  onClick={handleReauthorize}
                  className="px-3 py-1.5 text-xs rounded bg-accent/10 text-foreground hover:bg-surface-hover transition-colors"
                >
                  Re-authorize
                </button>
              )}
              <ProviderDisconnectControl
                canDisconnect={Boolean(provider?.authorized)}
                showConfirm={showDisconnectConfirm}
                isPending={disconnectMutation.isPending}
                onOpenConfirm={() => setShowDisconnectConfirm(true)}
                onConfirm={handleDisconnect}
                onCancel={() => setShowDisconnectConfirm(false)}
              />
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

      {/* WHOOP wear location */}
      {providerId === "whoop" && <WhoopWearLocationPicker />}

      {/* Stats overview */}
      {providerStats && <ProviderStatsBreakdown stats={providerStats} variant="full" />}

      {/* Sync history */}
      {!pushOnly && <SyncHistory key={`sync-history-${providerId}`} providerId={providerId} />}

      {/* Records browser */}
      <RecordsBrowser
        key={`records-browser-${providerId}`}
        providerId={providerId}
        stats={providerStats}
      />

      <ProviderDataDeleteControl
        providerId={providerId}
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

// ── Sync History ──

const SYNC_HISTORY_FILTER_COLUMNS = [
  { key: "syncedAt", label: "Time" },
  { key: "dataType", label: "Type" },
  { key: "status", label: "Status" },
  { key: "recordCount", label: "Records" },
  { key: "durationMs", label: "Duration" },
  { key: "errorMessage", label: "Error" },
  { key: "authFailureReason", label: "Auth Failure" },
  { key: "id", label: "Id" },
] as const;

function SyncHistory({ providerId }: { providerId: string }) {
  const [page, setPage] = useState(0);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const debouncedFilters = useDebouncedFilters(filters);
  const activeFilters = useMemo(() => pruneEmptyFilters(debouncedFilters), [debouncedFilters]);
  const pageSize = 20;
  const filterOptionsQuery = trpc.providerDetail.logFilterOptions.useQuery({ providerId });

  const logs = trpc.providerDetail.logs.useQuery({
    providerId,
    limit: pageSize,
    offset: page * pageSize,
    filters: activeFilters,
  });

  const rows = logs.isError ? [] : (logs.data ?? []);

  const handleFilterChange = useCallback((key: string, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(0);
  }, []);

  const getFilterOptions = useCallback(
    (columnKey: string) => toFilterOptions(columnKey, filterOptionsQuery.data?.[columnKey]),
    [filterOptionsQuery.data],
  );

  return (
    <section>
      <h2 className="text-sm font-medium text-muted uppercase tracking-wider mb-2">Sync History</h2>

      {logs.isLoading ? (
        <QueryStatePanel variant="loading" height={80} />
      ) : logs.isError ? (
        <QueryStatePanel error={logs.error} height={80} />
      ) : rows.length === 0 && Object.keys(activeFilters).length === 0 ? (
        <div className="text-xs text-subtle">No sync history yet.</div>
      ) : (
        <>
          <div className="card overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-subtle">
                  <th scope="col" className="text-left px-4 py-2 font-medium">
                    Time
                  </th>
                  <th scope="col" className="text-left px-4 py-2 font-medium">
                    Type
                  </th>
                  <th scope="col" className="text-left px-4 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="text-right px-4 py-2 font-medium">
                    Records
                  </th>
                  <th scope="col" className="text-right px-4 py-2 font-medium">
                    Duration
                  </th>
                  <th scope="col" className="text-left px-4 py-2 font-medium">
                    Error
                  </th>
                  <th scope="col" className="text-left px-4 py-2 font-medium">
                    Auth Failure
                  </th>
                  <th scope="col" className="text-left px-4 py-2 font-medium">
                    Id
                  </th>
                </tr>
                <TableFilterRow
                  columns={SYNC_HISTORY_FILTER_COLUMNS}
                  filters={filters}
                  onFilterChange={handleFilterChange}
                  getOptions={getFilterOptions}
                />
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={SYNC_HISTORY_FILTER_COLUMNS.length}
                      className="px-4 py-6 text-subtle"
                    >
                      No sync history matches the current filters.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b border-border/50 hover:bg-surface-hover transition-colors"
                    >
                      <td className="px-4 py-2 text-muted whitespace-nowrap">
                        {formatTime(row.syncedAt)}
                      </td>
                      <td className="px-4 py-2 text-muted">{row.dataType}</td>
                      <td className="px-4 py-2">
                        <span
                          className={`inline-flex items-center gap-1.5 ${
                            row.status === "success" ? "text-emerald-400" : "text-red-400"
                          }`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              row.status === "success" ? "bg-emerald-400" : "bg-red-400"
                            }`}
                          />
                          {row.status}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right text-foreground tabular-nums">
                        {row.recordCount ?? "—"}
                      </td>
                      <td className="px-4 py-2 text-right text-muted tabular-nums">
                        {row.durationMs != null
                          ? formatDurationSeconds(row.durationMs / 1000)
                          : "—"}
                      </td>
                      <td className="px-4 py-2 text-red-400/80 max-w-xs truncate">
                        {row.errorMessage ?? ""}
                      </td>
                      <td className="px-4 py-2 text-red-400/80 max-w-xs truncate">
                        {row.authFailureReason ?? ""}
                      </td>
                      <td className="px-4 py-2 text-muted max-w-xs truncate">{row.id}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between mt-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="text-xs px-3 py-1 rounded bg-accent/10 text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors"
            >
              Previous
            </button>
            <span className="text-xs text-subtle">Page {page + 1}</span>
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              disabled={rows.length < pageSize}
              className="text-xs px-3 py-1 rounded bg-accent/10 text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors"
            >
              Next
            </button>
          </div>
        </>
      )}
    </section>
  );
}

// ── Records Browser ──

function getStatCount(stats: ProviderStats, key: DataType): number {
  return stats[key];
}

function RecordsBrowser({
  providerId,
  stats,
}: {
  providerId: string;
  stats: ProviderStats | undefined;
}) {
  const availability = trpc.providerDetail.availableDataTypes.useQuery({ providerId });
  const availableTypes = DATA_TYPE_LABELS.filter((dataType) =>
    availability.data?.includes(dataType.key),
  );

  const [selectedTab, setSelectedTab] = useState<DataType>("activities");
  const activeTab = useMemo(() => {
    if (availableTypes.some((dt) => dt.key === selectedTab)) {
      return selectedTab;
    }
    return availableTypes[0]?.key ?? "activities";
  }, [availableTypes, selectedTab]);

  if (availability.isLoading) {
    return (
      <section>
        <h2 className="text-sm font-medium text-muted uppercase tracking-wider mb-2">Records</h2>
        <div className="text-xs text-subtle">Loading records...</div>
      </section>
    );
  }

  if (availability.isError) {
    return (
      <section>
        <h2 className="text-sm font-medium text-muted uppercase tracking-wider mb-2">Records</h2>
        <QueryStatePanel error={availability.error} height={80} />
      </section>
    );
  }

  if (availableTypes.length === 0) {
    return (
      <section>
        <h2 className="text-sm font-medium text-muted uppercase tracking-wider mb-2">Records</h2>
        <div className="text-xs text-subtle">No records yet for this provider.</div>
      </section>
    );
  }

  return (
    <section>
      <h2 className="text-sm font-medium text-muted uppercase tracking-wider mb-2">Records</h2>

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 mb-3">
        {availableTypes.map((dt) => (
          <button
            key={dt.key}
            type="button"
            onClick={() => setSelectedTab(dt.key)}
            className={`px-3 py-1.5 text-xs rounded transition-colors ${
              activeTab === dt.key
                ? "bg-accent/15 text-foreground"
                : "bg-accent/10 text-subtle hover:text-foreground"
            }`}
          >
            {dt.label}
            {stats && getStatCount(stats, dt.key) > 0 && (
              <span className="ml-1 text-dim">
                ({getStatCount(stats, dt.key).toLocaleString()})
              </span>
            )}
          </button>
        ))}
      </div>

      <RecordsTable
        key={`${providerId}:${activeTab}`}
        providerId={providerId}
        dataType={activeTab}
      />
    </section>
  );
}

// ── Records Table ──

function RecordsTable({ providerId, dataType }: { providerId: string; dataType: DataType }) {
  const [page, setPage] = useState(0);
  const [selectedRecord, setSelectedRecord] = useState<Record<string, unknown> | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const debouncedFilters = useDebouncedFilters(filters);
  const activeFilters = useMemo(() => pruneEmptyFilters(debouncedFilters), [debouncedFilters]);
  const pageSize = 25;
  const filterOptionsQuery = trpc.providerDetail.recordFilterOptions.useQuery({
    providerId,
    dataType,
  });

  const records = trpc.providerDetail.records.useQuery({
    providerId,
    dataType,
    limit: pageSize,
    offset: page * pageSize,
    filters: activeFilters,
  });

  const rows = records.isError ? [] : (records.data?.rows ?? []);
  const visibleColumns = records.data?.columns ?? [];
  const filterColumnNames = records.data?.filterColumns ?? visibleColumns;

  const handleFilterChange = useCallback((key: string, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(0);
  }, []);

  const filterColumns = useMemo(
    () => filterColumnNames.map((column) => ({ key: column, label: formatColumnName(column) })),
    [filterColumnNames],
  );

  const getFilterOptions = useCallback(
    (columnKey: string) => toFilterOptions(columnKey, filterOptionsQuery.data?.[columnKey]),
    [filterOptionsQuery.data],
  );

  const hasRaw = rows.some((row) => Object.hasOwn(row, "raw"));

  if (records.isLoading) {
    return <QueryStatePanel variant="loading" height={80} />;
  }

  if (records.isError) {
    return <QueryStatePanel error={records.error} height={80} />;
  }

  const emptyMessage =
    Object.keys(activeFilters).length === 0
      ? "No records found."
      : "No records match the current filters.";

  return (
    <>
      <RecordFiltersGrid
        columns={filterColumns}
        filters={filters}
        onFilterChange={handleFilterChange}
        getOptions={getFilterOptions}
      />

      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-subtle">
              {visibleColumns.map((col) => (
                <th
                  key={col}
                  scope="col"
                  className="text-left px-3 py-2 font-medium whitespace-nowrap"
                >
                  {formatColumnName(col)}
                </th>
              ))}
              {hasRaw && (
                <th scope="col" className="text-left px-3 py-2 font-medium">
                  Data
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={Math.max(visibleColumns.length + (hasRaw ? 1 : 0), 1)}
                  className="px-3 py-6 text-subtle"
                >
                  {records.isLoading ? "Loading records..." : emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row, idx) => (
                <tr
                  key={String(row.id ?? row.date ?? idx)}
                  className="border-b border-border/50 hover:bg-surface-hover transition-colors cursor-pointer"
                  onClick={() => setSelectedRecord(row)}
                >
                  {visibleColumns.map((col) => (
                    <td
                      key={col}
                      className="px-3 py-2 text-foreground whitespace-nowrap max-w-xs truncate"
                    >
                      {formatCellValue(row[col])}
                    </td>
                  ))}
                  {hasRaw && (
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedRecord(row);
                        }}
                        className="text-xs text-dim hover:text-muted transition-colors"
                      >
                        View
                      </button>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-2">
        <button
          type="button"
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={page === 0}
          className="text-xs px-3 py-1 rounded bg-accent/10 text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors"
        >
          Previous
        </button>
        <span className="text-xs text-subtle">Page {page + 1}</span>
        <button
          type="button"
          onClick={() => setPage((p) => p + 1)}
          disabled={rows.length < pageSize}
          className="text-xs px-3 py-1 rounded bg-accent/10 text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors"
        >
          Next
        </button>
      </div>

      {/* Record detail modal */}
      {selectedRecord && (
        <RecordDetailModal
          record={selectedRecord}
          onClose={() => setSelectedRecord(null)}
          activityId={
            dataType === "activities" && typeof selectedRecord.id === "string"
              ? selectedRecord.id
              : undefined
          }
        />
      )}
    </>
  );
}
