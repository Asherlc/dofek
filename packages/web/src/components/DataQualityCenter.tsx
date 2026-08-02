import {
  type DataQualityCheck,
  type DataQualityOverview,
  type DataQualityReviewDestination,
  getDataQualityDetailItems,
  getDataQualityReview,
  getDataQualityStatusLabel,
} from "@dofek/format/data-quality";
import { Link } from "@tanstack/react-router";

interface DataQualityCenterProps {
  data?: DataQualityOverview;
  loading?: boolean;
}

const reviewRoutes = {
  nutrition: "/nutrition",
  dashboard: "/dashboard",
  journal: "/tracking",
} as const satisfies Record<DataQualityReviewDestination, string>;

function statusClass(status: DataQualityCheck["status"]): string {
  switch (status) {
    case "attention":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "informational":
      return "border-border bg-surface-secondary text-muted";
    case "healthy":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
}

function DataQualityCheckCard({ qualityCheck }: { qualityCheck: DataQualityCheck }) {
  const review = getDataQualityReview(qualityCheck.key);
  return (
    <article className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-medium text-foreground">{qualityCheck.title}</h3>
          <p className="mt-1 text-sm leading-6 text-muted">{qualityCheck.message}</p>
        </div>
        <span
          className={`rounded-full border px-2 py-0.5 text-xs font-medium ${statusClass(qualityCheck.status)}`}
        >
          {getDataQualityStatusLabel(qualityCheck.status)}
        </span>
      </div>
      {qualityCheck.count > 0 ? (
        <p className="mt-3 text-xs font-medium text-subtle">
          {qualityCheck.count} {qualityCheck.label.toLowerCase()}
        </p>
      ) : null}
      {qualityCheck.details.length > 0 ? (
        <ul className="mt-3 space-y-1 text-xs leading-5 text-subtle">
          {getDataQualityDetailItems(qualityCheck.key, qualityCheck.details).map((detail) => (
            <li key={detail.key}>{detail.text}</li>
          ))}
        </ul>
      ) : null}
      <Link
        to={reviewRoutes[review.destination]}
        className="mt-3 inline-flex text-xs font-semibold text-accent hover:underline"
      >
        {review.label}
      </Link>
    </article>
  );
}

export function DataQualityCenter({ data, loading = false }: DataQualityCenterProps) {
  if (loading) {
    return (
      <section className="card p-6" aria-live="polite" aria-busy="true">
        <p className="text-sm text-muted">Loading data quality…</p>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="card p-6" aria-label="Data quality empty state">
        <h2 className="text-base font-semibold text-foreground">Data quality</h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          No data quality checks are available yet.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4" aria-labelledby="data-quality-title">
      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="data-quality-title" className="text-lg font-semibold text-foreground">
              Data quality
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted">{data.overallMessage}</p>
          </div>
          <span
            className={`rounded-full border px-2 py-0.5 text-xs font-medium ${statusClass(data.overallStatus)}`}
          >
            {getDataQualityStatusLabel(data.overallStatus)}
          </span>
        </div>
        <p className="mt-3 text-xs text-subtle">
          Last {data.window.days} days · through {data.window.endDate}
        </p>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {data.checks.map((qualityCheck) => (
          <DataQualityCheckCard key={qualityCheck.key} qualityCheck={qualityCheck} />
        ))}
      </div>
    </section>
  );
}
