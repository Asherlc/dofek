import { formatDurationSeconds, formatTime } from "@dofek/format/format";
import {
  type ProviderSyncLogTone,
  providerSyncLogPresentation,
} from "@dofek/providers/sync-log-presentation";

export interface ProviderSyncHistoryEntryData {
  id: string;
  syncedAt: string;
  dataType: string;
  status: string;
  recordCount: number | null;
  durationMs: number | null;
  errorMessage: string | null;
  authFailureReason: string | null;
}

interface ProviderSyncHistoryEntryProps {
  providerName: string;
  entry: ProviderSyncHistoryEntryData;
}

const toneClasses: Record<ProviderSyncLogTone, string> = {
  success: "border-l-emerald-400",
  warning: "border-l-amber-400",
  danger: "border-l-red-400",
};

export function ProviderSyncHistoryEntry({ providerName, entry }: ProviderSyncHistoryEntryProps) {
  const presentation = providerSyncLogPresentation({
    providerName,
    dataType: entry.dataType,
    status: entry.status,
    authFailureReason: entry.authFailureReason,
  });

  return (
    <article
      className={`rounded-lg border border-l-4 border-border bg-surface px-4 py-3 ${toneClasses[presentation.tone]}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-subtle">
            {presentation.dataTypeLabel}
          </p>
          <h3 className="text-sm font-semibold text-foreground">{presentation.heading}</h3>
          {presentation.message ? (
            <p className="mt-0.5 text-xs text-muted">{presentation.message}</p>
          ) : null}
        </div>
        <time className="text-xs text-subtle" dateTime={entry.syncedAt}>
          {formatTime(entry.syncedAt)}
        </time>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span>{entry.recordCount ?? "—"} records</span>
        {entry.durationMs !== null ? (
          <span>{formatDurationSeconds(entry.durationMs / 1000)}</span>
        ) : null}
      </div>

      <details className="mt-2 text-xs text-muted">
        <summary className="w-fit cursor-pointer text-foreground">Diagnostics</summary>
        <dl className="mt-2 grid gap-x-3 gap-y-1 sm:grid-cols-[max-content_1fr]">
          <dt className="text-subtle">Data type</dt>
          <dd className="break-all font-mono">{entry.dataType}</dd>
          <dt className="text-subtle">Status</dt>
          <dd className="break-all font-mono">{entry.status}</dd>
          {entry.authFailureReason ? (
            <>
              <dt className="text-subtle">Authorization reason</dt>
              <dd className="break-all font-mono">{entry.authFailureReason}</dd>
            </>
          ) : null}
          {entry.errorMessage ? (
            <>
              <dt className="text-subtle">Error</dt>
              <dd className="break-words">{entry.errorMessage}</dd>
            </>
          ) : null}
          <dt className="text-subtle">Log ID</dt>
          <dd className="break-all font-mono">{entry.id}</dd>
        </dl>
      </details>
    </article>
  );
}
