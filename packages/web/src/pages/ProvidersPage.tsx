import { useMemo, useState } from "react";
import { AppHeader } from "../components/AppHeader.tsx";
import { DataSourcesPanel } from "../components/DataSourcesPanel.tsx";
import { trpc } from "../lib/trpc.ts";

export function ProvidersPage() {
  const stats = trpc.sync.providerStats.useQuery();
  const providers = trpc.sync.providers.useQuery();
  const logs = trpc.sync.logs.useQuery({ limit: 100 });
  // Only poll system logs when a sync is actively running
  const activeSyncJob = trpc.sync.syncStatus.useQuery({ jobId: "" }, { enabled: false });
  const isSyncing = activeSyncJob.data?.status === "running";
  const systemLogs = trpc.sync.systemLogs.useQuery(
    { limit: 100 },
    { refetchInterval: isSyncing ? 5000 : false },
  );

  const [logFilter, setLogFilter] = useState<string | null>(null);

  const providerList = providers.data ?? [];
  const statsByProvider = useMemo(
    () => new Map((stats.data ?? []).map((s) => [s.providerId, s])),
    [stats.data],
  );

  const allProviders = useMemo(
    () => providerList.map((p) => ({ ...p, stats: statsByProvider.get(p.id) })),
    [providerList, statsByProvider],
  );

  const registeredIds = useMemo(() => new Set(providerList.map((p) => p.id)), [providerList]);
  const extraStats = useMemo(
    () => (stats.data ?? []).filter((s) => !registeredIds.has(s.providerId)),
    [stats.data, registeredIds],
  );

  const syncRows = (logs.data ?? []) as Array<{
    id: string;
    providerId: string;
    dataType: string;
    status: string;
    recordCount: number | null;
    errorMessage: string | null;
    durationMs: number | null;
    syncedAt: string;
  }>;

  // Pre-group logs by provider to avoid repeated .filter() in render loop
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

  const filteredLogs = logFilter ? syncRows.filter((r) => r.providerId === logFilter) : syncRows;

  const reversedSystemLogs = useMemo(
    () => [...(systemLogs.data ?? [])].reverse(),
    [systemLogs.data],
  );

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <AppHeader />
      <main className="mx-auto max-w-7xl p-6 space-y-8">
        {/* Sync Controls */}
        <section>
          <DataSourcesPanel />
        </section>

        {/* Provider Overview Cards */}
        <section>
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-4">
            Provider Overview
          </h2>
          {stats.isLoading ? (
            <div className="text-xs text-zinc-500">Loading stats...</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {allProviders.map((p) => (
                <ProviderCard
                  key={p.id}
                  name={p.name}
                  providerId={p.id}
                  authorized={p.authorized}
                  lastSyncedAt={p.lastSyncedAt}
                  stats={p.stats}
                  recentLogs={(logsByProvider.get(p.id) ?? []).slice(0, 5)}
                  onFilterLogs={() => setLogFilter((f) => (f === p.id ? null : p.id))}
                  isFiltered={logFilter === p.id}
                />
              ))}
              {extraStats.map((s) => (
                <ProviderCard
                  key={s.providerId}
                  name={formatProviderName(s.providerId)}
                  providerId={s.providerId}
                  authorized={true}
                  lastSyncedAt={(logsByProvider.get(s.providerId) ?? [])[0]?.syncedAt ?? null}
                  stats={s}
                  recentLogs={(logsByProvider.get(s.providerId) ?? []).slice(0, 5)}
                  onFilterLogs={() =>
                    setLogFilter((f) => (f === s.providerId ? null : s.providerId))
                  }
                  isFiltered={logFilter === s.providerId}
                />
              ))}
            </div>
          )}
        </section>

        {/* Sync History */}
        <section>
          <div className="flex items-center gap-3 mb-2">
            <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider">
              Sync History
            </h2>
            {logFilter && (
              <button
                type="button"
                onClick={() => setLogFilter(null)}
                className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors flex items-center gap-1"
              >
                {formatProviderName(logFilter)}
                <span className="text-zinc-500">&times;</span>
              </button>
            )}
          </div>
          <p className="text-xs text-zinc-600 mb-4">
            {logFilter
              ? `Showing logs for ${formatProviderName(logFilter)}`
              : "All provider sync operations"}
          </p>

          {logs.isLoading ? (
            <div className="text-xs text-zinc-500">Loading logs...</div>
          ) : filteredLogs.length === 0 ? (
            <div className="text-xs text-zinc-500">No sync logs yet.</div>
          ) : (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-zinc-900 z-10">
                  <tr className="border-b border-zinc-800 text-zinc-500">
                    <th className="text-left px-4 py-2 font-medium">Time</th>
                    <th className="text-left px-4 py-2 font-medium">Provider</th>
                    <th className="text-left px-4 py-2 font-medium">Type</th>
                    <th className="text-left px-4 py-2 font-medium">Status</th>
                    <th className="text-right px-4 py-2 font-medium">Records</th>
                    <th className="text-right px-4 py-2 font-medium">Duration</th>
                    <th className="text-left px-4 py-2 font-medium">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLogs.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors"
                    >
                      <td className="px-4 py-2 text-zinc-400 whitespace-nowrap">
                        {formatTime(row.syncedAt)}
                      </td>
                      <td className="px-4 py-2 text-zinc-200">
                        <button
                          type="button"
                          onClick={() =>
                            setLogFilter((f) => (f === row.providerId ? null : row.providerId))
                          }
                          className="hover:text-emerald-400 transition-colors"
                        >
                          {formatProviderName(row.providerId)}
                        </button>
                      </td>
                      <td className="px-4 py-2 text-zinc-400">{row.dataType}</td>
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
                      <td className="px-4 py-2 text-right text-zinc-300 tabular-nums">
                        {row.recordCount ?? "—"}
                      </td>
                      <td className="px-4 py-2 text-right text-zinc-400 tabular-nums">
                        {row.durationMs != null ? `${(row.durationMs / 1000).toFixed(1)}s` : "—"}
                      </td>
                      <td className="px-4 py-2 text-red-400/80 max-w-xs truncate">
                        {row.errorMessage ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* System Logs */}
        <section>
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-1">
            System Logs
          </h2>
          <p className="text-xs text-zinc-600 mb-4">
            Live console output (auto-refreshes every 5s)
          </p>

          {systemLogs.isLoading ? (
            <div className="text-xs text-zinc-500">Loading...</div>
          ) : (systemLogs.data ?? []).length === 0 ? (
            <div className="text-xs text-zinc-500">No system logs yet.</div>
          ) : (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-x-auto max-h-72 overflow-y-auto font-mono">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-zinc-900 z-10">
                  <tr className="border-b border-zinc-800 text-zinc-500">
                    <th className="text-left px-4 py-2 font-medium w-40">Time</th>
                    <th className="text-left px-4 py-2 font-medium w-16">Level</th>
                    <th className="text-left px-4 py-2 font-medium">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {reversedSystemLogs.map((entry, i) => (
                    <tr
                      key={`${entry.timestamp}-${i}`}
                      className="border-b border-zinc-800/50 hover:bg-zinc-800/30"
                    >
                      <td className="px-4 py-1.5 text-zinc-500 whitespace-nowrap">
                        {formatTime(entry.timestamp)}
                      </td>
                      <td className="px-4 py-1.5">
                        <span
                          className={
                            entry.level === "error"
                              ? "text-red-400"
                              : entry.level === "warn"
                                ? "text-amber-400"
                                : "text-zinc-500"
                          }
                        >
                          {entry.level}
                        </span>
                      </td>
                      <td className="px-4 py-1.5 text-zinc-300 whitespace-pre-wrap break-all">
                        {entry.message}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

// ── Provider Card ──

interface ProviderCardProps {
  name: string;
  providerId: string;
  authorized: boolean;
  lastSyncedAt: string | null;
  stats?: {
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
  };
  recentLogs: Array<{
    status: string;
    syncedAt: string;
    recordCount: number | null;
    durationMs: number | null;
    errorMessage: string | null;
  }>;
  onFilterLogs: () => void;
  isFiltered: boolean;
}

function ProviderCard({
  name,
  authorized,
  lastSyncedAt,
  stats,
  recentLogs,
  onFilterLogs,
  isFiltered,
}: ProviderCardProps) {
  const totalRecords = stats
    ? stats.activities +
      stats.dailyMetrics +
      stats.sleepSessions +
      stats.bodyMeasurements +
      stats.foodEntries +
      stats.healthEvents +
      stats.metricStream +
      stats.nutritionDaily +
      stats.labResults +
      stats.journalEntries
    : 0;

  const recentErrors = recentLogs.filter((l) => l.status === "error").length;
  const recentSuccesses = recentLogs.filter((l) => l.status === "success").length;

  // Health indicator
  const health = !authorized
    ? "disconnected"
    : recentLogs.length === 0
      ? "no-data"
      : recentErrors > 0 && recentSuccesses === 0
        ? "failing"
        : recentErrors > 0
          ? "degraded"
          : "healthy";

  const healthColors = {
    healthy: "border-emerald-500/30 bg-emerald-500/5",
    degraded: "border-amber-500/30 bg-amber-500/5",
    failing: "border-red-500/30 bg-red-500/5",
    disconnected: "border-blue-500/30 bg-blue-500/5",
    "no-data": "border-zinc-700 bg-zinc-900/50",
  };

  const healthDot = {
    healthy: "bg-emerald-400",
    degraded: "bg-amber-400",
    failing: "bg-red-400",
    disconnected: "bg-blue-400",
    "no-data": "bg-zinc-600",
  };

  const healthLabel = {
    healthy: "Healthy",
    degraded: "Degraded",
    failing: "Failing",
    disconnected: "Not Connected",
    "no-data": "No Syncs",
  };

  // Data type breakdown — only show non-zero
  const breakdown = stats
    ? [
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
      ].filter((b) => b.count > 0)
    : [];

  return (
    <div
      className={`rounded-lg border p-4 transition-colors ${healthColors[health]} ${
        isFiltered ? "ring-1 ring-emerald-500/50" : ""
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${healthDot[health]}`} />
          <h3 className="text-sm font-semibold text-zinc-200">{name}</h3>
        </div>
        <span className="text-xs text-zinc-500">{healthLabel[health]}</span>
      </div>

      {/* Total Records + Activities */}
      <div className="mb-3">
        <div className="text-2xl font-bold text-zinc-100 tabular-nums">
          {totalRecords.toLocaleString()}
        </div>
        <div className="text-xs text-zinc-500">total records</div>
        {stats && stats.activities > 0 && (
          <div className="mt-1">
            <span className="text-lg font-semibold text-emerald-400 tabular-nums">
              {stats.activities.toLocaleString()}
            </span>
            <span className="text-xs text-zinc-400 ml-1.5">activities</span>
          </div>
        )}
      </div>

      {/* Data breakdown */}
      {breakdown.length > 0 && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 mb-3">
          {breakdown.map((b) => (
            <div key={b.label} className="flex justify-between text-xs">
              <span className="text-zinc-500">{b.label}</span>
              <span className="text-zinc-300 tabular-nums">{b.count.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}

      {/* Recent sync status */}
      <div className="flex items-center justify-between pt-2 border-t border-zinc-800/50">
        <div className="flex items-center gap-1">
          {recentLogs.slice(0, 5).map((l, i) => (
            <span
              key={`${l.syncedAt}-${i}`}
              className={`w-1.5 h-1.5 rounded-full ${
                l.status === "success" ? "bg-emerald-400" : "bg-red-400"
              }`}
              title={`${l.status} — ${formatTime(l.syncedAt)}${l.errorMessage ? `: ${l.errorMessage}` : ""}`}
            />
          ))}
          {recentLogs.length === 0 && (
            <span className="text-xs text-zinc-600">No sync history</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {lastSyncedAt && (
            <span className="text-xs text-zinc-600">{formatRelativeTime(lastSyncedAt)}</span>
          )}
          <button
            type="button"
            onClick={onFilterLogs}
            className={`text-xs transition-colors ${
              isFiltered
                ? "text-emerald-400 hover:text-emerald-300"
                : "text-zinc-600 hover:text-zinc-400"
            }`}
          >
            logs
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ──

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatProviderName(id: string): string {
  return id
    .split(/[_-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
