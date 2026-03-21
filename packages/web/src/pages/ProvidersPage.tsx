import { useState } from "react";
import { AppHeader } from "../components/AppHeader.tsx";
import { DataSourcesPanel } from "../components/DataSourcesPanel.tsx";
import { trpc } from "../lib/trpc.ts";

export function ProvidersPage() {
  const logs = trpc.sync.logs.useQuery({ limit: 100 });

  const [logFilter, setLogFilter] = useState<string | null>(null);

  const syncRows: Array<{
    id: string;
    providerId: string;
    dataType: string;
    status: string;
    recordCount: number | null;
    errorMessage: string | null;
    durationMs: number | null;
    syncedAt: string;
  }> = logs.data ?? [];

  const filteredLogs = logFilter ? syncRows.filter((r) => r.providerId === logFilter) : syncRows;

  return (
    <div className="min-h-screen bg-page text-foreground overflow-x-hidden">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-3 sm:px-6 py-4 sm:py-6 space-y-6 sm:space-y-8">
        {/* Data Sources — unified sync controls + stats */}
        <section>
          <DataSourcesPanel />
        </section>

        {/* Sync History */}
        <section>
          <div className="flex items-center gap-3 mb-2">
            <h2 className="text-sm font-medium text-muted uppercase tracking-wider">
              Sync History
            </h2>
            {logFilter && (
              <button
                type="button"
                onClick={() => setLogFilter(null)}
                className="text-xs px-2 py-0.5 rounded bg-accent/10 text-foreground hover:bg-surface-hover transition-colors flex items-center gap-1"
              >
                {formatProviderName(logFilter)}
                <span className="text-subtle">&times;</span>
              </button>
            )}
          </div>
          <p className="text-xs text-dim mb-4">
            {logFilter
              ? `Showing logs for ${formatProviderName(logFilter)}`
              : "All provider sync operations"}
          </p>

          {logs.isLoading ? (
            <div className="text-xs text-subtle">Loading logs...</div>
          ) : filteredLogs.length === 0 ? (
            <div className="text-xs text-subtle">No sync logs yet.</div>
          ) : (
            <div className="card overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-surface-solid z-10">
                  <tr className="border-b border-border text-subtle">
                    <th scope="col" className="text-left px-4 py-2 font-medium">
                      Time
                    </th>
                    <th scope="col" className="text-left px-4 py-2 font-medium">
                      Provider
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
                  {filteredLogs.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b border-border/50 hover:bg-surface-hover transition-colors"
                    >
                      <td className="px-4 py-2 text-muted whitespace-nowrap">
                        {formatTime(row.syncedAt)}
                      </td>
                      <td className="px-4 py-2 text-foreground">
                        <button
                          type="button"
                          onClick={() =>
                            setLogFilter((f) => (f === row.providerId ? null : row.providerId))
                          }
                          className="hover:text-accent transition-colors"
                        >
                          {formatProviderName(row.providerId)}
                        </button>
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
      </main>
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

function formatProviderName(id: string): string {
  return id
    .split(/[_-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
