import { formatRelativeTime } from "@dofek/format/format";
import type { ProcessingAlert } from "@dofek/providers/processing-alerts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageLayout } from "../components/PageLayout.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { trpc } from "../lib/trpc.ts";

export function AlertsPage() {
  const alertsQuery = trpc.processing.alerts.useQuery();
  const trpcUtils = trpc.useUtils();
  const [startedProviderId, setStartedProviderId] = useState<string | null>(null);
  const syncMutation = trpc.sync.triggerSync.useMutation({
    onSuccess: async (_result, variables) => {
      setStartedProviderId(variables.providerId ?? null);
      await trpcUtils.processing.alerts.invalidate();
    },
  });

  function retrySync(alert: ProcessingAlert) {
    if (!alert.providerId) return;
    syncMutation.mutate({ providerId: alert.providerId, sinceDays: 7 });
  }

  return (
    <PageLayout
      title="Alerts"
      subtitle="Problems that need your attention appear here until they are resolved"
    >
      {alertsQuery.isLoading && !alertsQuery.data ? (
        <QueryStatePanel variant="loading" />
      ) : alertsQuery.error && !alertsQuery.data ? (
        <QueryStatePanel
          error={alertsQuery.error}
          message="Alerts could not be loaded. Refresh the page to try again."
        />
      ) : alertsQuery.data?.alerts.length === 0 ? (
        <section className="rounded-lg border border-border bg-surface px-5 py-8 text-center">
          <h3 className="text-sm font-semibold text-foreground">Nothing needs your attention</h3>
          <p className="mt-1 text-sm text-muted">
            New sync, connection, and import problems will appear here.
          </p>
        </section>
      ) : (
        <div className="space-y-3">
          {alertsQuery.data?.alerts.map((alert) => (
            <article
              key={alert.id}
              className="rounded-lg border border-l-4 border-border border-l-red-500 bg-surface px-4 py-4"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">{alert.title}</h3>
                  <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">{alert.message}</p>
                  <p className="mt-2 text-xs text-subtle">{formatRelativeTime(alert.occurredAt)}</p>
                </div>
                <AlertAction
                  alert={alert}
                  disabled={syncMutation.isPending}
                  onRetrySync={() => retrySync(alert)}
                />
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
    "inline-flex shrink-0 items-center justify-center rounded-md bg-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-50";
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
