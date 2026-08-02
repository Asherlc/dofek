import {
  type DataQualityCheck,
  type DataQualityOverview,
  type DataQualityReviewDestination,
  getDataQualityDetailItems,
  getDataQualityReview,
  getDataQualityStatusLabel,
} from "@dofek/format/data-quality";
import { operationalStatusColors } from "@dofek/scoring/colors";
import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";

interface DataQualityCenterProps {
  data?: DataQualityOverview;
  loading?: boolean;
}

const reviewRoutes = {
  nutrition: "/nutrition",
  activities: "/activities",
  dashboard: "/dashboard",
  journal: "/tracking",
} as const satisfies Record<DataQualityReviewDestination, string>;

function statusStyle(status: DataQualityCheck["status"]): CSSProperties {
  const tone = (() => {
    switch (status) {
      case "attention":
        return operationalStatusColors.warning;
      case "informational":
        return operationalStatusColors.neutral;
      case "healthy":
        return operationalStatusColors.success;
    }
  })();

  return {
    backgroundColor: tone.surface,
    borderColor: tone.border,
    color: tone.foreground,
  };
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
          className="rounded-full border px-2 py-0.5 text-xs font-medium"
          style={statusStyle(qualityCheck.status)}
        >
          {getDataQualityStatusLabel(qualityCheck.status)}
        </span>
      </div>
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
      <section className="card p-6" aria-labelledby="data-quality-empty-title">
        <h2 id="data-quality-empty-title" className="text-base font-semibold text-foreground">
          Data quality
        </h2>
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
            className="rounded-full border px-2 py-0.5 text-xs font-medium"
            style={statusStyle(data.overallStatus)}
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
