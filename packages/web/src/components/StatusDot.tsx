import type { SyncStatus } from "./DataSourcesSyncTypes.ts";

export function StatusDot({ status }: { status: SyncStatus }) {
  const colors = {
    idle: "bg-dim",
    syncing: "bg-amber-400 animate-pulse",
    done: "bg-emerald-400",
    error: "bg-red-400",
  };
  const labels: Record<SyncStatus, string> = {
    idle: "Idle",
    syncing: "Syncing",
    done: "Synced",
    error: "Error",
  };
  return (
    <output
      className={`inline-block w-2 h-2 rounded-full ${colors[status]}`}
      aria-label={labels[status]}
    />
  );
}
