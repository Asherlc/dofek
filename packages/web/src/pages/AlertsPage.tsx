import { formatRelativeTime } from "@dofek/format/format";
import {
  PROCESSING_ALERTS_EMPTY_PREVIEW,
  type ProcessingAlert,
  processingAlertsFailurePresentation,
} from "@dofek/providers/processing-alerts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { EmptyStatePreview } from "../components/EmptyStatePreview.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { PaginationControls } from "../components/PaginationControls.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { trpc } from "../lib/trpc.ts";

const PAGE_SIZE = 20;

export function AlertsPage() {
  const alertsQuery = trpc.processing.alerts.useQuery();
  const trpcUtils = trpc.useUtils();
  const [startedProviderId, setStartedProviderId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const syncMutation = trpc.sync.triggerSync.useMutation({
    onSuccess: async (_result, variables) => {
      setStartedProviderId(variables.providerId ?? null);
      await trpcUtils.processing.alerts.invalidate();
    },
  });
  const dismissMutation = trpc.processing.dismiss.useMutation({
    onSuccess: async () => {
      await trpcUtils.processing.alerts.invalidate();
    },
  });

  function retrySync(alert: ProcessingAlert) {
    if (!alert.providerId) return;
    syncMutation.mutate({ providerId: alert.providerId, sinceDays: 7 });
  }

  const alerts = alertsQuery.data?.alerts ?? [];
  const totalPages = Math.ceil(alerts.length / PAGE_SIZE);
  const currentPage = Math.min(page, Math.max(totalPages - 1, 0));
  const visibleAlerts = alerts.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const failurePresentation = alertsQuery.error
    ? processingAlertsFailurePresentation({
        errorMessage: alertsQuery.error.message,
        hasSnapshot: alertsQuery.data !== undefined,
        lastCheckedLabel: alertsQuery.data
          ? formatRelativeTime(alertsQuery.data.generatedAt)
          : null,
      })
    : null;
  const failurePanel = failurePresentation ? (
    <QueryStatePanel
      error={alertsQuery.error}
      title={failurePresentation.title}
      message={failurePresentation.message}
      onRetry={() => void alertsQuery.refetch()}
      retryLabel={failurePresentation.retryLabel}
      retrying={alertsQuery.isFetching}
    />
  ) : null;

  return (
    <PageLayout
      title="Alerts"
      subtitle="Problems that need your attention appear here until they are resolved"
    >
      {alertsQuery.isLoading && !alertsQuery.data ? (
        <QueryStatePanel variant="loading" />
      ) : failurePresentation && (!alertsQuery.data || alerts.length === 0) ? (
        failurePanel
      ) : alertsQuery.data?.alerts.length === 0 ? (
        <EmptyStatePreview content={PROCESSING_ALERTS_EMPTY_PREVIEW} />
      ) : (
        <div className="space-y-3">
          {failurePanel}
          {dismissMutation.error ? (
            <p
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700"
              role="alert"
            >
              {dismissMutation.error.message}
            </p>
          ) : null}
          {visibleAlerts.map((alert) => (
            <article
              key={alert.id}
              className="rounded-lg border border-l-4 border-border border-l-red-500 bg-surface px-4 py-4"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">{alert.title}</h3>
                  <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">{alert.message}</p>
                  <ul className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-xs font-medium text-foreground">
                    {alert.datasetLabels.map((label) => (
                      <li key={label}>{label}</li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs text-subtle">
                    Occurred: {formatRelativeTime(alert.occurredAt)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                  <AlertAction
                    alert={alert}
                    disabled={syncMutation.isPending}
                    onRetrySync={() => retrySync(alert)}
                  />
                  <button
                    type="button"
                    className="inline-flex items-center justify-center rounded-md border border-border-strong px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-surface-hover disabled:opacity-50"
                    disabled={dismissMutation.isPending}
                    aria-label={`Dismiss ${alert.providerLabel ?? "processing"} alert`}
                    onClick={() => dismissMutation.mutate({ operationId: alert.id })}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
              {startedProviderId === alert.providerId && alert.providerLabel ? (
                <output className="mt-3 block text-xs font-medium text-emerald-600">
                  {alert.providerLabel} sync started.
                </output>
              ) : null}
              {syncMutation.error && syncMutation.variables?.providerId === alert.providerId ? (
                <p className="mt-3 text-xs font-medium text-red-600" role="alert">
                  {syncMutation.error.message}
                </p>
              ) : null}
            </article>
          ))}
          <PaginationControls
            page={currentPage}
            pageSize={PAGE_SIZE}
            totalItems={alerts.length}
            itemLabel="alerts"
            onPageChange={setPage}
          />
        </div>
      )}
    </PageLayout>
  );
}

function AlertAction({
  alert,
  disabled,
  onRetrySync,
}: {
  alert: ProcessingAlert;
  disabled: boolean;
  onRetrySync: () => void;
}) {
  const actionClass =
    "inline-flex shrink-0 items-center justify-center rounded-md bg-accent px-3 py-2 text-xs font-semibold text-on-accent transition-colors hover:bg-accent/90 disabled:opacity-50";
  if (alert.action === "retry_sync") {
    return (
      <button type="button" className={actionClass} disabled={disabled} onClick={onRetrySync}>
        {alert.actionLabel}
      </button>
    );
  }
  if (alert.action === "reconnect" && alert.providerId) {
    return (
      <Link className={actionClass} to="/providers/$id" params={{ id: alert.providerId }}>
        {alert.actionLabel}
      </Link>
    );
  }
  if (alert.action === "retry_import") {
    return (
      <Link className={actionClass} to="/settings">
        {alert.actionLabel}
      </Link>
    );
  }
  return (
    <Link className={actionClass} to="/support">
      {alert.actionLabel}
    </Link>
  );
}
