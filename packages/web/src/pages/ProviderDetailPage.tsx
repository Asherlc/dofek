import { Link, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { PageLayout } from "../components/PageLayout.tsx";
import { ProviderLogo } from "../components/ProviderLogo.tsx";
import { formatRelativeTime, formatTime } from "../lib/dates.ts";
import { formatNumber } from "../lib/format.ts";
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

const DATA_TYPES = [
  { key: "activities", label: "Activities" },
  { key: "dailyMetrics", label: "Daily Metrics" },
  { key: "sleepSessions", label: "Sleep" },
  { key: "bodyMeasurements", label: "Body" },
  { key: "foodEntries", label: "Food" },
  { key: "healthEvents", label: "Events" },
  { key: "metricStream", label: "Metric Stream" },
  { key: "nutritionDaily", label: "Nutrition" },
  { key: "labResults", label: "Lab Results" },
  { key: "journalEntries", label: "Journal" },
] as const;

type DataType = (typeof DATA_TYPES)[number]["key"];

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

  // Disconnect
  const disconnectMutation = trpc.providerDetail.disconnect.useMutation();
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);

  const handleSync = useCallback(
    async (fullSync = false, customSinceDays?: number) => {
      setSyncStatus("syncing");
      setSyncMessage(null);
      try {
        const { jobId } = await syncMutation.mutateAsync({
          providerId,
          sinceDays: fullSync ? undefined : (customSinceDays ?? 7),
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
              {showDisconnectConfirm ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted">Are you sure?</span>
                  <button
                    type="button"
                    onClick={handleDisconnect}
                    disabled={disconnectMutation.isPending}
                    className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
                  >
                    {disconnectMutation.isPending ? "Disconnecting..." : "Confirm"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowDisconnectConfirm(false)}
                    className="px-3 py-1.5 text-xs rounded bg-accent/10 text-foreground hover:bg-surface-hover transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowDisconnectConfirm(true)}
                  className="px-3 py-1.5 text-xs rounded bg-accent/10 text-red-400 hover:bg-surface-hover transition-colors"
                >
                  Disconnect
                </button>
              )}
            </div>
          </div>
          {syncMessage && (
            <div className={`text-xs ${syncStatus === "error" ? "text-red-400" : "text-accent"}`}>
              {syncMessage}
            </div>
          )}
        </section>
      )}

      {/* Stats overview */}
      {providerStats && <StatsOverview stats={providerStats} />}

      {/* Sync history */}
      <SyncHistory providerId={providerId} />

      {/* Records browser */}
      <RecordsBrowser providerId={providerId} stats={providerStats} />
    </PageLayout>
  );
}

// ── Stats Overview ──

interface ProviderStatsData {
  activities: number;
  dailyMetrics: number;
  sleepSessions: number;
  bodyMeasurements: number;
  foodEntries: number;
  healthEvents: number;
  metricStream: number;
  nutritionDaily: number;
  labResults: number;
  journalEntries: number;
}

function StatsOverview({ stats }: { stats: ProviderStatsData }) {
  const breakdown = [
    { label: "Activities", count: stats.activities },
    { label: "Metric Stream", count: stats.metricStream },
    { label: "Daily Metrics", count: stats.dailyMetrics },
    { label: "Sleep", count: stats.sleepSessions },
    { label: "Body", count: stats.bodyMeasurements },
    { label: "Food", count: stats.foodEntries },
    { label: "Nutrition", count: stats.nutritionDaily },
    { label: "Events", count: stats.healthEvents },
    { label: "Lab Results", count: stats.labResults },
    { label: "Journal", count: stats.journalEntries },
  ].filter((b) => b.count > 0);

  const total = breakdown.reduce((sum, b) => sum + b.count, 0);

  if (total === 0) return null;

  return (
    <section className="card p-4">
      <div className="flex items-baseline gap-2 mb-3">
        <span className="text-2xl font-bold text-foreground tabular-nums">
          {total.toLocaleString()}
        </span>
        <span className="text-sm text-subtle">total records</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {breakdown.map((b) => (
          <div key={b.label} className="text-center">
            <div className="text-lg font-semibold text-foreground tabular-nums">
              {b.count.toLocaleString()}
            </div>
            <div className="text-xs text-subtle">{b.label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Sync History ──

function SyncHistory({ providerId }: { providerId: string }) {
  const [page, setPage] = useState(0);
  const pageSize = 20;

  const logs = trpc.providerDetail.logs.useQuery({
    providerId,
    limit: pageSize,
    offset: page * pageSize,
  });

  const rows = logs.data ?? [];

  return (
    <section>
      <h2 className="text-sm font-medium text-muted uppercase tracking-wider mb-2">Sync History</h2>

      {logs.isLoading ? (
        <div className="text-xs text-subtle">Loading logs...</div>
      ) : rows.length === 0 ? (
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
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
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
                      {row.durationMs != null ? `${formatNumber(row.durationMs / 1000)}s` : "—"}
                    </td>
                    <td className="px-4 py-2 text-red-400/80 max-w-xs truncate">
                      {row.errorMessage ?? ""}
                    </td>
                  </tr>
                ))}
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

function getStatCount(stats: ProviderStatsData, key: DataType): number {
  return stats[key];
}

function RecordsBrowser({
  providerId,
  stats,
}: {
  providerId: string;
  stats: ProviderStatsData | undefined;
}) {
  const availableTypes = DATA_TYPES.filter((dt) => {
    if (!stats) return true;
    return getStatCount(stats, dt.key) > 0;
  });

  const [activeTab, setActiveTab] = useState<DataType>(availableTypes[0]?.key ?? "activities");

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

      <RecordsTable providerId={providerId} dataType={activeTab} />
    </section>
  );
}

// ── Records Table ──

function RecordsTable({ providerId, dataType }: { providerId: string; dataType: DataType }) {
  const [page, setPage] = useState(0);
  const [selectedRecord, setSelectedRecord] = useState<Record<string, unknown> | null>(null);
  const pageSize = 25;

  const records = trpc.providerDetail.records.useQuery({
    providerId,
    dataType,
    limit: pageSize,
    offset: page * pageSize,
  });

  const rows = records.data?.rows ?? [];

  // Reset page when data type changes
  const [lastDataType, setLastDataType] = useState(dataType);
  if (dataType !== lastDataType) {
    setPage(0);
    setLastDataType(dataType);
    setSelectedRecord(null);
  }

  if (records.isLoading) {
    return <div className="text-xs text-subtle">Loading records...</div>;
  }

  if (rows.length === 0) {
    return <div className="text-xs text-subtle">No records found.</div>;
  }

  // Get column names from the first row, excluding raw data and internal fields
  const excludedColumns = new Set(["raw", "user_id"]);
  const columns = Object.keys(rows[0] ?? {}).filter((col) => !excludedColumns.has(col));

  // Prioritize certain columns
  const priorityCols = ["id", "name", "date", "started_at", "recorded_at", "activity_type", "type"];
  const sortedColumns = [
    ...priorityCols.filter((c) => columns.includes(c)),
    ...columns.filter((c) => !priorityCols.includes(c)),
  ];

  // Show only first few columns in the table
  const visibleColumns = sortedColumns.slice(0, 6);
  const hasRaw = Object.keys(rows[0] ?? {}).includes("raw");

  return (
    <>
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
            {rows.map((row, idx) => (
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
            ))}
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

// ── Helpers ──

export function formatColumnName(col: string): string {
  return col.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  const str = String(value);
  // Format ISO dates
  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
    return formatTime(str);
  }
  return str;
}
