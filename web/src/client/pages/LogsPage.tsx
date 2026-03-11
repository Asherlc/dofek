import { AppHeader } from "../components/AppHeader.tsx";
import { trpc } from "../lib/trpc.ts";

export function LogsPage() {
  const logs = trpc.sync.logs.useQuery({ limit: 200 });
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
      <main className="mx-auto max-w-7xl p-6">
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
