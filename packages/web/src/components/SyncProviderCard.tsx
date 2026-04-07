import type { ProviderStats } from "@dofek/providers/provider-stats";
import { Link } from "@tanstack/react-router";
import { formatRelativeTime, formatTime } from "../lib/dates.ts";
import type { ProviderState, SyncLogEntry } from "./DataSourcesSyncTypes.ts";
import { ProviderLogo } from "./ProviderLogo.tsx";
import { ProviderStatsBreakdown } from "./ProviderStatsBreakdown.tsx";
import { StatusDot } from "./StatusDot.tsx";

export function SyncProviderCard({
  provider,
  state,
  needsAuth,
  needsReauth,
  stats,
  recentLogs,
  onSync,
  onFullSync,
}: {
  provider: { id: string; name: string; lastSyncedAt: string | null; authorized: boolean };
  state: ProviderState;
  needsAuth: boolean;
  needsReauth: boolean;
  stats: ProviderStats | undefined;
  recentLogs: SyncLogEntry[];
  onSync: () => void;
  onFullSync: () => void;
}) {
  return (
    <div className="flex flex-col rounded-lg border border-border bg-surface px-4 py-3 transition-colors">
      {/* Header with sync trigger */}
      <button
        type="button"
        onClick={onSync}
        disabled={state.status === "syncing"}
        className="flex items-center gap-2 hover:opacity-80 disabled:opacity-50"
        title={
          needsReauth ? "Click to reconnect" : needsAuth ? "Click to connect" : "Sync last 7 days"
        }
      >
        <ProviderLogo provider={provider.id} size={18} />
        {needsReauth ? (
          <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />
        ) : needsAuth ? (
          <span className="inline-block w-2 h-2 rounded-full bg-blue-400" />
        ) : (
          <StatusDot status={state.status} />
        )}
        <span className="text-sm font-medium text-foreground">{provider.name}</span>
        {needsReauth && <span className="text-xs text-amber-400">Reconnect</span>}
        {needsAuth && !needsReauth && <span className="text-xs text-blue-400">Connect</span>}
        {state.status === "syncing" && <span className="text-xs text-subtle">...</span>}
      </button>

      {/* Progress bar during sync */}
      {state.status === "syncing" && (
        <div className="mt-2">
          {state.percentage != null && (
            <div className="w-full h-1.5 rounded-full bg-accent/10 overflow-hidden">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                style={{ width: `${state.percentage}%` }}
              />
            </div>
          )}
          {state.message && <span className="text-xs text-subtle mt-1 block">{state.message}</span>}
        </div>
      )}

      {/* Status message */}
      {state.message && state.status !== "syncing" && (
        <span className="text-xs text-subtle mt-1">{state.message}</span>
      )}
      {state.status !== "syncing" &&
        !state.message &&
        provider.lastSyncedAt &&
        formatRelativeTime(provider.lastSyncedAt) && (
          <span className="text-xs text-dim mt-1">
            Last sync: {formatRelativeTime(provider.lastSyncedAt)}
          </span>
        )}

      {/* Stats summary */}
      {stats && <ProviderStatsBreakdown stats={stats} />}

      {/* Recent sync dots + full sync button + details link */}
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/50">
        <div className="flex items-center gap-1">
          {recentLogs.map((l) => (
            <span
              key={`${l.syncedAt}-${l.status}-${l.recordCount}-${l.durationMs}`}
              className={`w-1.5 h-1.5 rounded-full ${
                l.status === "success" ? "bg-emerald-400" : "bg-red-400"
              }`}
              title={`${l.status} — ${formatTime(l.syncedAt)}`}
            />
          ))}
          {recentLogs.length === 0 && <span className="text-xs text-dim">No sync history</span>}
        </div>
        <div className="flex items-center gap-3">
          {!needsAuth && !needsReauth && state.status !== "syncing" && (
            <button
              type="button"
              onClick={onFullSync}
              className="text-xs text-dim hover:text-muted transition-colors"
            >
              Full sync
            </button>
          )}
          <Link
            to="/providers/$id"
            params={{ id: provider.id }}
            className="text-xs text-dim hover:text-muted transition-colors"
          >
            Details
          </Link>
        </div>
      </div>
    </div>
  );
}
