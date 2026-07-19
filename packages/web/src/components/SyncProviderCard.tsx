import { formatRelativeTime, formatTime } from "@dofek/format/format";
import type { ProviderStats } from "@dofek/providers/provider-stats";
import { Link } from "@tanstack/react-router";
import type { ProviderState, SyncLogEntry, SyncProviderSummary } from "./DataSourcesSyncTypes.ts";
import { OperationProgressBar } from "./OperationProgressBar.tsx";
import { ProviderLogo } from "./ProviderLogo.tsx";
import { ProviderStatsBreakdown } from "./ProviderStatsBreakdown.tsx";
import { StatusDot } from "./StatusDot.tsx";

export function SyncProviderCard({
  provider,
  state,
  needsAuth,
  needsReauth,
  pushOnly = false,
  stats,
  recentLogs,
  onSync,
  onFullSync,
}: {
  provider: Pick<
    SyncProviderSummary,
    "id" | "name" | "lastSyncedAt" | "authorized" | "description"
  >;
  state: ProviderState;
  needsAuth: boolean;
  needsReauth: boolean;
  pushOnly?: boolean;
  stats: ProviderStats | undefined;
  recentLogs: SyncLogEntry[];
  onSync: () => void;
  onFullSync: () => void;
}) {
  const lastSyncedRelative = provider.lastSyncedAt
    ? formatRelativeTime(provider.lastSyncedAt)
    : null;
  const primaryActionLabel = needsReauth ? "Reconnect" : needsAuth ? "Connect" : "Sync";
  const primaryActionTitle = needsReauth
    ? `Reconnect ${provider.name}`
    : needsAuth
      ? `Connect ${provider.name}`
      : `Sync ${provider.name} from the last 7 days`;
  const fullSyncTitle = `Sync all available ${provider.name} data`;

  return (
    <div className="flex flex-col rounded-lg border border-border bg-surface px-4 py-3 transition-colors">
      <div className="flex items-center gap-2">
        <ProviderLogo provider={provider.id} size={18} />
        {pushOnly ? (
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              provider.authorized ? "bg-emerald-400" : "bg-subtle"
            }`}
          />
        ) : needsReauth ? (
          <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />
        ) : needsAuth ? (
          <span className="inline-block w-2 h-2 rounded-full bg-blue-400" />
        ) : (
          <StatusDot status={state.status} />
        )}
        <span className="text-sm font-medium text-foreground">{provider.name}</span>
        {pushOnly && <span className="text-xs text-subtle">Mobile sync</span>}
        {!pushOnly && needsReauth && <span className="text-xs text-amber-400">Reconnect</span>}
        {!pushOnly && needsAuth && !needsReauth && (
          <span className="text-xs text-blue-400">Connect</span>
        )}
        {!pushOnly && state.status === "syncing" && (
          <span className="text-xs text-subtle">...</span>
        )}
      </div>

      {pushOnly && provider.description && (
        <span className="text-xs text-subtle mt-1">{provider.description}</span>
      )}

      {!pushOnly && state.status === "syncing" && (
        <div className="mt-2">
          <OperationProgressBar percentage={state.percentage} message={state.message} />
        </div>
      )}

      {/* Status message */}
      {!pushOnly && state.message && state.status !== "syncing" && (
        <span className="text-xs text-subtle mt-1">{state.message}</span>
      )}
      {state.status !== "syncing" && !state.message && lastSyncedRelative && (
        <span className="text-xs text-dim mt-1">
          {pushOnly ? "Last received" : "Last sync"}: {lastSyncedRelative}
        </span>
      )}

      {/* Stats summary */}
      {stats && <ProviderStatsBreakdown stats={stats} />}

      {/* Recent sync dots + action links */}
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/50">
        <div className="flex items-center gap-1">
          {pushOnly ? (
            <span className="text-xs text-dim">
              {provider.authorized ? "Synced via iOS app" : "Waiting for mobile sync"}
            </span>
          ) : (
            <>
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
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          {!pushOnly && state.status !== "syncing" && (
            <button
              type="button"
              onClick={onSync}
              title={primaryActionTitle}
              aria-label={primaryActionTitle}
              className="text-xs text-muted hover:text-foreground transition-colors"
            >
              {primaryActionLabel}
            </button>
          )}
          {!pushOnly && !needsAuth && !needsReauth && state.status !== "syncing" && (
            <button
              type="button"
              onClick={onFullSync}
              title={fullSyncTitle}
              aria-label={fullSyncTitle}
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
