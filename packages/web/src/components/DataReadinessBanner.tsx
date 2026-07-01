export type DataReadinessStatus = "healthy" | "syncing" | "stale" | "missing" | "blocked";

export interface DataReadinessDataset {
  key: "dailyMetrics" | "sleep" | "activity";
  label: string;
  rawRows: number;
  latestRawAt: string | null;
  latestReadModelAt: string | null;
  cdcLagSeconds: number | null;
  readModelLagSeconds: number | null;
  status: DataReadinessStatus;
  message: string;
}

export interface DataReadinessSnapshot {
  overallStatus: DataReadinessStatus;
  generatedAt: string;
  datasets: DataReadinessDataset[];
}

interface DataReadinessBannerProps {
  data?: DataReadinessSnapshot;
  error?: { message?: string } | null;
  loading?: boolean;
}

const headingByStatus: Record<Exclude<DataReadinessStatus, "healthy">, string> = {
  syncing: "Data is syncing now",
  stale: "Dashboard summaries are catching up",
  missing: "No data has synced yet",
  blocked: "Data pipeline needs attention",
};

const classNameByStatus: Record<Exclude<DataReadinessStatus, "healthy">, string> = {
  syncing: "border-blue-300 bg-blue-50 text-blue-950",
  stale: "border-amber-300 bg-amber-50 text-amber-950",
  missing: "border-slate-300 bg-slate-50 text-slate-950",
  blocked: "border-red-300 bg-red-50 text-red-950",
};

export function DataReadinessBanner({
  data,
  error = null,
  loading = false,
}: DataReadinessBannerProps) {
  if (loading) return null;

  if (error) {
    return (
      <output className="block w-full rounded-lg border border-red-300 bg-red-50 p-4 text-red-950">
        <h2 className="text-sm font-semibold">Data readiness is unavailable</h2>
        <p className="mt-1 text-sm">{error.message ?? "The data readiness check failed."}</p>
      </output>
    );
  }

  if (!data || data.overallStatus === "healthy") return null;

  const relevantDatasets = data.datasets.filter((dataset) => dataset.status !== "healthy");
  const status = data.overallStatus;

  return (
    <output
      className={`block w-full rounded-lg border p-4 ${classNameByStatus[status]}`}
      aria-live={status === "syncing" ? "polite" : undefined}
    >
      <h2 className="text-sm font-semibold">{headingByStatus[status]}</h2>
      {relevantDatasets.length > 0 ? (
        <ul className="mt-3 grid gap-2 md:grid-cols-3">
          {relevantDatasets.map((dataset) => (
            <li key={dataset.key} className="rounded-md bg-white/60 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide">{dataset.label}</p>
              <p className="mt-1 text-sm">{dataset.message}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </output>
  );
}
