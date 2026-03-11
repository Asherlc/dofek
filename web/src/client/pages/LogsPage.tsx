import { AppHeader } from "../components/AppHeader.tsx";
import { trpc } from "../lib/trpc.ts";

export function LogsPage() {
  const logs = trpc.sync.logs.useQuery({ limit: 200 });
  const systemLogs = trpc.sync.systemLogs.useQuery({ limit: 200 }, { refetchInterval: 5000 });
  const rows = (logs.data ?? []) as Array<{
    id: string;
    providerId: string;
    dataType: string;
    status: string;
    recordCount: number | null;
    errorMessage: string | null;
    durationMs: number | null;
    syncedAt: string;
  }>;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <AppHeader activePage="logs" />
      <main className="mx-auto max-w-7xl p-6 space-y-8">
        {/* Sync Logs */}
        <section>
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-1">
            Sync Logs
          </h2>
          <p className="text-xs text-zinc-600 mb-4">History of all provider sync operations</p>

          {logs.isLoading ? (
            <div className="text-xs text-zinc-500">Loading logs...</div>
          ) : rows.length === 0 ? (
            <div className="text-xs text-zinc-500">No sync logs yet.</div>
          ) : (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
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
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors"
                    >
                      <td className="px-4 py-2 text-zinc-400 whitespace-nowrap">
                        {formatTime(row.syncedAt)}
                      </td>
                      <td className="px-4 py-2 text-zinc-200 capitalize">{row.providerId}</td>
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
          <p className="text-xs text-zinc-600 mb-4">Raw console output (auto-refreshes every 5s)</p>

          {systemLogs.isLoading ? (
            <div className="text-xs text-zinc-500">Loading...</div>
          ) : (systemLogs.data ?? []).length === 0 ? (
            <div className="text-xs text-zinc-500">No system logs yet.</div>
          ) : (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-x-auto max-h-96 overflow-y-auto font-mono">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-zinc-900">
                  <tr className="border-b border-zinc-800 text-zinc-500">
                    <th className="text-left px-4 py-2 font-medium w-40">Time</th>
                    <th className="text-left px-4 py-2 font-medium w-16">Level</th>
                    <th className="text-left px-4 py-2 font-medium">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {[...(systemLogs.data ?? [])].reverse().map((entry, i) => (
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
