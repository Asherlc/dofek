import { formatRelativeTime } from "@dofek/format/format";
import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { isCloudPushProvider } from "@dofek/providers/provider-connection";
import type { ProviderStats } from "@dofek/providers/provider-stats";
import { syncCardSummary } from "@dofek/providers/sync-card-summary";
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
    | "id"
    | "name"
    | "authType"
    | "lastSyncedAt"
    | "lastSuccessfulSyncAt"
    | "lastProcessedUpdateAt"
    | "syncFreshness"
    | "authorized"
    | "description"
  >;
  state: ProviderState;
  needsAuth: boolean;
  needsReauth: boolean;
  pushOnly?: boolean;
  stats: ProviderStats | undefined;
  recentLogs: SyncLogEntry[];
  onSync: () => void;
}) {
  const mobileOnly = pushOnly && provider.authType === "push:mobile";
  const automaticUpdates = isCloudPushProvider({ pushOnly, authType: provider.authType });
  const summary = syncCardSummary({
    lastSyncAt: provider.lastSyncedAt,
    lastSuccessfulSyncAt: provider.lastSuccessfulSyncAt,
    recentLogs,
    pushOnly: automaticUpdates,
    lastProcessedUpdateAt: provider.lastProcessedUpdateAt,
  });
  const lastAttemptAt = automaticUpdates
    ? provider.lastProcessedUpdateAt
    : pushOnly
      ? provider.lastSyncedAt
      : summary.lastAttemptAt;
  const lastSyncedRelative = lastAttemptAt ? formatRelativeTime(lastAttemptAt) : null;
  const lastSuccessfulSyncRelative = provider.lastSuccessfulSyncAt
    ? formatRelativeTime(provider.lastSuccessfulSyncAt)
    : null;
  const requiresAuthorization =
    provider.authType !== "none" &&
    provider.authType !== "file-import" &&
    provider.authType !== "push:mobile";
  const primaryActionLabel = needsReauth ? "Reconnect" : needsAuth ? "Connect" : "Sync";
  const primaryActionTitle = needsReauth
    ? `Reconnect ${provider.name}`
    : needsAuth
      ? `Connect ${provider.name}`
      : `Sync ${provider.name} from the last 7 days`;
  const latestSync = summary.latestIssue;
  const latestSyncColors =
    latestSync?.status === "error"
      ? operationalStatusColors.danger
      : operationalStatusColors.warning;
  const syncFreshness = !pushOnly && !needsAuth ? provider.syncFreshness : null;
  const syncFreshnessColors =
    syncFreshness?.status === "overdue"
      ? operationalStatusColors.warning
      : syncFreshness?.status === "current"
        ? operationalStatusColors.success
        : operationalStatusColors.neutral;

  return (
    <div className="flex flex-col rounded-lg border border-border bg-surface px-4 py-3 transition-colors">
      <div className="flex items-center gap-2">
        <ProviderLogo provider={provider.id} size={18} />
        {mobileOnly ? (
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
        ) : !automaticUpdates && state.status !== "idle" ? (
          <StatusDot status={state.status} />
        ) : null}
        <span className="text-sm font-medium text-foreground">{provider.name}</span>
        {pushOnly && (
          <span className="text-xs text-subtle">
            {mobileOnly ? "Mobile sync" : "Updates automatically"}
          </span>
        )}
        {needsReauth && (
          <span className="text-xs" style={{ color: operationalStatusColors.warning.foreground }}>
            Authorization expired
          </span>
        )}
        {needsAuth && !needsReauth && (
          <span className="text-xs" style={{ color: operationalStatusColors.info.foreground }}>
            Not connected
          </span>
        )}
      </div>

      {mobileOnly && provider.description && (
        <span className="text-xs text-subtle mt-1">{provider.description}</span>
      )}

      {!pushOnly && state.status === "syncing" && (
        <div className="mt-2">
          <OperationProgressBar percentage={state.percentage} message={state.message} />
        </div>
      )}

      {/* Status message */}
      {!pushOnly && state.message && state.status !== "syncing" && (
        <span className="text-xs text-subtle mt-1">
          {state.status === "error"
            ? userFacingErrorMessage(state.message, "The sync failed. Please try again.")
            : state.message}
        </span>
      )}
      {(automaticUpdates || (state.status !== "syncing" && !state.message)) &&
        lastSyncedRelative && (
          <span className="text-xs text-dim mt-1">
            {automaticUpdates
              ? "Last update processed"
              : pushOnly
                ? "Last received"
                : "Last attempt"}
            : {lastSyncedRelative}
          </span>
        )}
      {!pushOnly && state.status !== "syncing" && lastSuccessfulSyncRelative && (
        <span className="text-xs text-dim mt-1">
          Last successful sync: {lastSuccessfulSyncRelative}
        </span>
      )}

      {/* Stats summary */}
      {stats && <ProviderStatsBreakdown stats={stats} />}

      {/* Latest sync status + action links */}
      <div className="flex flex-wrap items-center justify-between gap-2 mt-2 pt-2 border-t border-border/50">
        <div className="flex flex-wrap items-center gap-2">
          {automaticUpdates && !needsAuth && !needsReauth && (
            <span className="text-xs text-dim">Connected</span>
          )}
          {mobileOnly ? (
            <span className="text-xs text-dim">
              {provider.authorized ? "Synced via iOS app" : "Waiting for mobile sync"}
            </span>
          ) : latestSync ? (
            <output
              aria-label={latestSync.accessibilityLabel}
              className="inline-flex items-center gap-1.5 text-xs"
              style={{
                color:
                  latestSync.status === "error"
                    ? "var(--color-danger)"
                    : latestSyncColors.foreground,
              }}
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full"
                style={{
                  backgroundColor: latestSyncColors.indicator,
                }}
              />
              {latestSync.label}
            </output>
          ) : automaticUpdates && !needsAuth && !needsReauth && !summary.hasHistory ? (
            <span className="text-xs text-dim">Waiting for first update</span>
          ) : !pushOnly && !summary.hasHistory ? (
            <span className="text-xs text-dim">No sync history</span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {syncFreshness && (
            <div
              role={syncFreshness.status === "overdue" ? "alert" : undefined}
              className="max-w-56 rounded border px-2 py-1 text-xs"
              style={{
                backgroundColor: syncFreshnessColors.surface,
                borderColor: syncFreshnessColors.border,
                color: syncFreshnessColors.foreground,
              }}
            >
              <span className="font-medium">{syncFreshness.label}</span>
              {syncFreshness.status !== "current" && (
                <span className="block">{syncFreshness.description}</span>
              )}
            </div>
          )}
          {(!pushOnly || (requiresAuthorization && (needsAuth || needsReauth))) &&
            state.status !== "syncing" && (
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
