import {
  formatDateYmd,
  formatDurationSeconds,
  formatRelativeTime,
  formatTableCellValue,
  formatTime,
} from "@dofek/format/format";
import { DATA_TYPE_LABELS, type ProviderStats } from "@dofek/providers/provider-stats";
import {
  parseWhoopWearLocation,
  WHOOP_WEAR_LOCATION_SETTING_KEY,
  WHOOP_WEAR_LOCATIONS,
  type WhoopWearLocation,
} from "@dofek/providers/whoop";
import { Link, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { PageLayout } from "../components/PageLayout.tsx";
import { ProviderDisconnectControl } from "../components/ProviderDisconnectControl.tsx";
import { ProviderLogo } from "../components/ProviderLogo.tsx";
import { ProviderStatsBreakdown } from "../components/ProviderStatsBreakdown.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { pollSyncJob } from "../lib/poll-sync-job.ts";
import { trpc } from "../lib/trpc.ts";

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

export function ProviderDetailPage() {
  const { id: providerId } = useParams({ from: "/providers/$id" });

  const providers = trpc.sync.providers.useQuery();
  const stats = trpc.sync.providerStats.useQuery();
  const trpcUtils = trpc.useUtils();

  const provider = (providers.data ?? []).find((p) => p.id === providerId);
  const providerStats = (stats.data ?? []).find((s) => s.providerId === providerId);

  // Sync state
  const syncMutation = trpc.sync.triggerSync.useMutation();
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "done" | "error">("idle");
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

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
      try {
        const { jobId } = await syncMutation.mutateAsync({
          providerId,
          ...input,
        });
        await pollSyncJob({
          jobId,
          providerIds: [providerId],
          fetchStatus: (id) => trpcUtils.sync.syncStatus.fetch({ jobId: id }, { staleTime: 0 }),
          updateState: (_id, state) => {
            if (state.status === "done") {
              setSyncStatus("done");
              setSyncMessage("Sync complete");
            } else if (state.status === "error") {
              setSyncStatus("error");
              setSyncMessage(state.message ?? "Sync failed");
            }
          },
          onComplete: () => {
            trpcUtils.sync.providers.invalidate();
            trpcUtils.sync.providerStats.invalidate();
            trpcUtils.providerDetail.logs.invalidate();
            trpcUtils.providerDetail.records.invalidate();
          },
        });
      } catch (err: unknown) {
        setSyncStatus("error");
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
                {provider.importOnly ? (
                  <span className="text-xs text-subtle">Import only</span>
                ) : provider.authorized ? (
                  <span className="text-xs text-emerald-400">Connected</span>
                ) : (
                  <span className="text-xs text-subtle">Not connected</span>
                )}
                {!provider.importOnly &&
                  provider.lastSyncedAt &&
                  formatRelativeTime(provider.lastSyncedAt) && (
                    <span className="text-xs text-dim">
                      Last sync: {formatRelativeTime(provider.lastSyncedAt)}
                    </span>
                  )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Sync controls */}
      {!provider?.importOnly && (
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
          {syncMessage && (
            <div className={`text-xs ${syncStatus === "error" ? "text-red-400" : "text-accent"}`}>
              {syncMessage}
            </div>
          )}
        </section>
      )}

      {/* WHOOP wear location */}
      {providerId === "whoop" && <WhoopWearLocationPicker />}

      {/* Stats overview */}
      {providerStats && <ProviderStatsBreakdown stats={providerStats} variant="full" />}

      {/* Sync history */}
      <SyncHistory key={providerId} providerId={providerId} />

      {/* Records browser */}
      <RecordsBrowser
        providerId={providerId}
        stats={providerStats}
        statsLoading={stats.isLoading}
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

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debouncedValue;
}

function useDebouncedFilters(filters: Record<string, string>, delayMs = 300) {
  return useDebouncedValue(filters, delayMs);
}

function pruneEmptyFilters(filters: Record<string, string>): Record<string, string> {
  const pruned: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value.trim()) pruned[key] = value.trim();
  }
  return pruned;
}

function TableFilterRow({
  columns,
  filters,
  onFilterChange,
  align = "left",
  trailingCells = 0,
}: {
  columns: ReadonlyArray<{ key: string; label: string }>;
  filters: Record<string, string>;
  onFilterChange: (key: string, value: string) => void;
  align?: "left" | "right";
  trailingCells?: number;
}) {
  return (
    <tr className="border-b border-border/50 bg-page/40">
      {columns.map((column) => (
        <th key={column.key} scope="col" className="px-2 py-1.5 font-normal">
          <input
            type="text"
            value={filters[column.key] ?? ""}
            onChange={(event) => onFilterChange(column.key, event.target.value)}
            placeholder={`Filter ${column.label}`}
            aria-label={`Filter ${column.label}`}
            className={`w-full min-w-[5rem] px-2 py-1 text-xs bg-accent/10 border border-border rounded text-foreground placeholder:text-dim focus:outline-none focus:border-border-strong ${
              align === "right" ? "text-right" : "text-left"
            }`}
          />
        </th>
      ))}
      {trailingCells > 0 && <th key="raw-data-column" scope="col" className="px-2 py-1.5" />}
    </tr>
  );
}

function RecordFiltersGrid({
  columns,
  filters,
  onFilterChange,
}: {
  columns: ReadonlyArray<{ key: string; label: string }>;
  filters: Record<string, string>;
  onFilterChange: (key: string, value: string) => void;
}) {
  if (columns.length === 0) return null;

  return (
    <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {columns.map((column) => (
        <label key={column.key} className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wider text-subtle">
            {column.label}
          </span>
          <input
            type="text"
            value={filters[column.key] ?? ""}
            onChange={(event) => onFilterChange(column.key, event.target.value)}
            placeholder={`Filter ${column.label}`}
            aria-label={`Filter ${column.label}`}
            className="w-full px-2 py-1.5 text-xs bg-accent/10 border border-border rounded text-foreground placeholder:text-dim focus:outline-none focus:border-border-strong"
          />
        </label>
      ))}
    </div>
  );
}

function SyncHistory({ providerId }: { providerId: string }) {
  const [page, setPage] = useState(0);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const debouncedFilters = useDebouncedFilters(filters);
  const activeFilters = useMemo(() => pruneEmptyFilters(debouncedFilters), [debouncedFilters]);
  const pageSize = 20;

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
  statsLoading,
}: {
  providerId: string;
  stats: ProviderStats | undefined;
  statsLoading: boolean;
}) {
  const availableTypes = DATA_TYPE_LABELS.filter((dt) => {
    if (!stats) return false;
    return getStatCount(stats, dt.key) > 0;
  });

  const [activeTab, setActiveTab] = useState<DataType>("activities");
  const [lastProviderId, setLastProviderId] = useState(providerId);

  if (providerId !== lastProviderId) {
    setLastProviderId(providerId);
    setActiveTab(availableTypes[0]?.key ?? "activities");
  }

  const activeTabAvailable = availableTypes.some((dt) => dt.key === activeTab);
  if (stats && availableTypes.length > 0 && !activeTabAvailable) {
    setActiveTab(availableTypes[0]?.key ?? "activities");
  }

  if (statsLoading) {
    return (
      <section>
        <h2 className="text-sm font-medium text-muted uppercase tracking-wider mb-2">Records</h2>
        <div className="text-xs text-subtle">Loading records...</div>
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
            onClick={() => setActiveTab(dt.key)}
            className={`px-3 py-1.5 text-xs rounded transition-colors ${
              activeTab === dt.key
                ? "bg-accent/15 text-foreground"
                : "bg-accent/10 text-subtle hover:text-foreground"
            }`}
          >
            {dt.label}
            {stats && (
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
        <RecordDetailModal record={selectedRecord} onClose={() => setSelectedRecord(null)} />
      )}
    </>
  );
}

// ── Record Detail Modal ──

export function RecordDetailModal({
  record,
  onClose,
}: {
  record: Record<string, unknown>;
  onClose: () => void;
}) {
  const rawValue = record.raw;
  const raw = typeof rawValue === "object" && rawValue !== null ? rawValue : null;

  // All fields except raw and user_id
  const fields = Object.entries(record).filter(([key]) => key !== "raw" && key !== "user_id");
  // Split into non-null and null fields so populated data is easy to find
  const populatedFields = fields.filter(([, value]) => value !== null && value !== undefined);
  const nullFields = fields.filter(([, value]) => value === null || value === undefined);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <button
        type="button"
        className="absolute inset-0 w-full h-full cursor-default"
        onClick={onClose}
        aria-label="Close dialog"
      />
      <div className="relative bg-surface-solid border border-border-strong rounded-xl p-6 w-full max-w-4xl max-h-[90vh] overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-foreground">Record Detail</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-subtle hover:text-foreground text-lg leading-none p-1"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Populated fields */}
        <div className="mb-4">
          <h4 className="text-xs font-medium text-muted uppercase tracking-wider mb-2">Fields</h4>
          <div className="rounded-lg border border-border bg-page divide-y divide-border/50">
            {populatedFields.map(([key, value]) => (
              <div key={key} className="flex gap-4 px-3 py-1.5 text-xs">
                <span className="text-subtle shrink-0 w-48">{formatColumnName(key)}</span>
                <span className="text-foreground break-all whitespace-pre-wrap min-w-0">
                  {formatCellValue(value)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Null fields — collapsed by default */}
        {nullFields.length > 0 && (
          <details className="mb-4">
            <summary className="text-xs font-medium text-subtle uppercase tracking-wider mb-2 cursor-pointer hover:text-muted">
              Empty Fields ({nullFields.length})
            </summary>
            <div className="text-xs text-dim flex flex-wrap gap-x-4 gap-y-0.5 mt-1">
              {nullFields.map(([key]) => (
                <span key={key}>{formatColumnName(key)}</span>
              ))}
            </div>
          </details>
        )}

        {/* Raw provider data */}
        {raw && (
          <details open>
            <summary className="text-xs font-medium text-muted uppercase tracking-wider mb-2 cursor-pointer hover:text-foreground">
              Raw Provider Data
            </summary>
            <pre className="text-xs text-muted bg-page rounded-lg p-3 overflow-x-auto overflow-y-auto max-h-[60vh]">
              {JSON.stringify(raw, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}

// ── WHOOP Wear Location Picker ──

function WhoopWearLocationPicker() {
  const setting = trpc.settings.get.useQuery({ key: WHOOP_WEAR_LOCATION_SETTING_KEY });
  const setSettingMutation = trpc.settings.set.useMutation();
  const trpcUtils = trpc.useUtils();

  const currentLocation = parseWhoopWearLocation(setting.data?.value);

  const handleChange = (location: WhoopWearLocation) => {
    trpcUtils.settings.get.setData(
      { key: WHOOP_WEAR_LOCATION_SETTING_KEY },
      { key: WHOOP_WEAR_LOCATION_SETTING_KEY, value: location },
    );
    setSettingMutation.mutate(
      { key: WHOOP_WEAR_LOCATION_SETTING_KEY, value: location },
      {
        onSettled: () => {
          trpcUtils.settings.get.invalidate({ key: WHOOP_WEAR_LOCATION_SETTING_KEY });
        },
      },
    );
  };

  return (
    <section className="card p-4 space-y-3">
      <div>
        <h2 className="text-sm font-medium text-foreground">Wear Location</h2>
        <p className="text-xs text-subtle mt-0.5">
          Where do you wear your WHOOP? This helps us interpret your sensor data.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {WHOOP_WEAR_LOCATIONS.map((location) => (
          <button
            key={location.id}
            type="button"
            onClick={() => handleChange(location.id)}
            className={`text-left px-3 py-2.5 rounded-lg border transition-colors ${
              currentLocation === location.id
                ? "border-emerald-500 bg-emerald-500/10"
                : "border-border-strong bg-accent/5 hover:bg-surface-hover"
            }`}
          >
            <div className="text-xs font-medium text-foreground">{location.label}</div>
            <div className="text-xs text-subtle mt-0.5">{location.description}</div>
          </button>
        ))}
      </div>
    </section>
  );
}

// ── Helpers ──

export function formatColumnName(col: string): string {
  return col.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatCellValue(value: unknown): string {
  return formatTableCellValue(value);
}
