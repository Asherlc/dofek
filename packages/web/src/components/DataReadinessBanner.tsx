import {
  bannerHeading,
  DATA_READINESS_ERROR_MESSAGE,
  dataReadinessMessage,
  freshnessLabel,
} from "@dofek/providers/data-readiness-banner";

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
  syncingProviders?: Array<{ id: string; name: string }>;
  datasets: DataReadinessDataset[];
}

interface DataReadinessBannerProps {
  data?: DataReadinessSnapshot;
  error?: { message?: string } | null;
  loading?: boolean;
  contextLabel?: string;
}

const classNameByStatus: Record<Exclude<DataReadinessStatus, "healthy">, string> = {
  syncing: "border-slate-200 border-l-blue-500 text-slate-950",
  stale: "border-slate-200 border-l-amber-500 text-slate-950",
  missing: "border-slate-200 border-l-slate-400 text-slate-950",
  blocked: "border-slate-200 border-l-red-500 text-slate-950",
};

const indicatorClassNameByStatus: Record<Exclude<DataReadinessStatus, "healthy">, string> = {
  syncing: "border-blue-500",
  stale: "bg-amber-500",
  missing: "bg-slate-400",
  blocked: "bg-red-500",
};

const datasetClassNameByStatus: Record<DataReadinessStatus, string> = {
  healthy: "border-emerald-100 bg-emerald-50/70",
  syncing: "border-blue-100 bg-blue-50/70",
  stale: "border-amber-100 bg-amber-50/70",
  missing: "border-slate-200 bg-slate-50",
  blocked: "border-red-100 bg-red-50/70",
};

function gridClassName(datasetCount: number): string {
  if (datasetCount === 1) return "md:grid-cols-1";
  if (datasetCount === 2) return "md:grid-cols-2";
  return "md:grid-cols-3";
}

export function DataReadinessBanner({
  data,
  error = null,
  loading = false,
  contextLabel,
}: DataReadinessBannerProps) {
  if (loading) return null;

  if (error) {
    return (
      <output className="block w-full rounded-lg border border-l-4 border-slate-200 border-l-red-500 bg-white px-3 py-2.5 text-slate-950 shadow-sm">
        {contextLabel ? (
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {contextLabel}
          </p>
        ) : null}
        <h2 className="text-sm font-semibold">Data readiness is unavailable</h2>
        <p className="mt-0.5 text-xs text-slate-600">{DATA_READINESS_ERROR_MESSAGE}</p>
      </output>
    );
  }

  if (!data || data.overallStatus === "healthy") return null;

  const relevantDatasets = data.datasets.filter((dataset) => dataset.status !== "healthy");
  const status = data.overallStatus;
  const checkedAt = freshnessLabel(data);
  const datasetGridClassName = gridClassName(relevantDatasets.length);

  return (
    <output
      className={`block w-full rounded-lg border border-l-4 bg-white px-3 py-2.5 shadow-sm ${classNameByStatus[status]}`}
      aria-live={status === "syncing" ? "polite" : undefined}
    >
      <div className="flex items-start gap-2.5">
        {status === "syncing" ? (
          <span
            aria-hidden="true"
            className={`mt-0.5 block h-4 w-4 shrink-0 rounded-full border-2 border-r-transparent motion-safe:animate-spin ${indicatorClassNameByStatus[status]}`}
          />
        ) : (
          <span
            aria-hidden="true"
            className={`mx-1 mt-1.5 block h-2 w-2 shrink-0 rounded-full ${indicatorClassNameByStatus[status]}`}
          />
        )}
        <div className="min-w-0 flex-1">
          {contextLabel ? (
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              {contextLabel}
            </p>
          ) : null}
          <h2 className="text-sm font-semibold leading-5">{bannerHeading(data)}</h2>
          {checkedAt ? <p className="text-xs leading-4 text-slate-600">{checkedAt}</p> : null}
        </div>
      </div>
      {relevantDatasets.length > 0 ? (
        <ul className={`mt-2 grid gap-1.5 ${datasetGridClassName}`}>
          {relevantDatasets.map((dataset) => (
            <li
              key={dataset.key}
              className={`rounded-md border px-2.5 py-2 md:flex md:items-baseline md:gap-2 ${datasetClassNameByStatus[dataset.status]}`}
            >
              <p className="shrink-0 text-xs font-semibold uppercase tracking-wide">
                {dataset.label}
              </p>
              <p className="mt-0.5 text-sm leading-5 text-slate-700 md:mt-0 md:border-l md:border-slate-200 md:pl-2">
                {dataReadinessMessage(dataset)}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </output>
  );
}
