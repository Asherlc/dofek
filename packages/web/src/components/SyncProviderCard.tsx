import { formatRelativeTime } from "@dofek/format/format";
import type { ProviderStats } from "@dofek/providers/provider-stats";
import { operationalStatusColors } from "@dofek/scoring/colors";
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
  const latestLog = recentLogs.reduce<SyncLogEntry | undefined>((latest, entry) => {
    if (!latest || entry.syncedAt > latest.syncedAt) return entry;
    return latest;
  }, undefined);
  const latestSyncFailed = latestLog?.status !== "success";

  return (
    <div className="flex flex-col rounded-lg border border-border bg-surface px-4 py-3 transition-colors">
      <div className="flex items-center gap-2">
        <ProviderLogo provider={provider.id} size={18} />
        {pushOnly ? (
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{
              backgroundColor: provider.authorized
                ? operationalStatusColors.success.indicator
                : operationalStatusColors.neutral.indicator,
            }}
          />
        ) : needsReauth ? (
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: operationalStatusColors.warning.indicator }}
          />
        ) : needsAuth ? (
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: operationalStatusColors.info.indicator }}
          />
        ) : (
          <StatusDot status={state.status} />
        )}
        <span className="text-sm font-medium text-foreground">{provider.name}</span>
        {pushOnly && <span className="text-xs text-subtle">Mobile sync</span>}
        {!pushOnly && needsReauth && (
          <span className="text-xs" style={{ color: operationalStatusColors.warning.foreground }}>
            Authorization expired
          </span>
        )}
        {!pushOnly && needsAuth && !needsReauth && (
          <span className="text-xs" style={{ color: operationalStatusColors.info.foreground }}>
            Not connected
          </span>
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

      {/* Latest sync status + action links */}
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/50">
        <div className="flex items-center gap-1">
          {pushOnly ? (
            <span className="text-xs text-dim">
              {provider.authorized ? "Synced via iOS app" : "Waiting for mobile sync"}
            </span>
          ) : latestLog ? (
            <output
              aria-label={latestSyncFailed ? "Sync needs attention" : "Sync current"}
              className="inline-flex items-center gap-1.5 text-xs"
              style={{
                color: latestSyncFailed
                  ? operationalStatusColors.danger.foreground
                  : operationalStatusColors.success.foreground,
              }}
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full"
                style={{
                  backgroundColor: latestSyncFailed
                    ? operationalStatusColors.danger.indicator
                    : operationalStatusColors.success.indicator,
                }}
              />
              {latestSyncFailed ? "Latest sync failed" : "Sync current"}
            </output>
          ) : (
            <span className="text-xs text-dim">No sync history</span>
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
          <Link
            to="/providers/$id"
            params={{ id: provider.id }}
            aria-label={`View ${provider.name} details`}
            className="text-xs text-dim hover:text-muted transition-colors"
          >
            Details
          </Link>
        </div>
      </div>
    </div>
  );
}
