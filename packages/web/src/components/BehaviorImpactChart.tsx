import type { ProviderProvenance } from "@dofek/providers/providers";
import type { BehaviorAssociation } from "dofek-server/types";
import { useState } from "react";
import { selectedRangeQueryInput, type TimeRangeDays } from "../lib/timeRange.ts";
import { trpc } from "../lib/trpc.ts";
import { EvidenceDetails } from "./EvidenceDetails.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

function ReadinessAssociationBar({
  label,
  readinessDifferencePercent,
  category,
  yesCount,
  noCount,
  sources,
  association,
}: {
  label: string;
  readinessDifferencePercent: number | null;
  category: string;
  yesCount: number;
  noCount: number;
  sources: ProviderProvenance[];
  association: BehaviorAssociation;
}) {
  const maxBar = 50; // max percentage width
  const barWidth =
    readinessDifferencePercent === null
      ? 0
      : Math.min(Math.abs(readinessDifferencePercent), maxBar);
  const isHigher = association.direction === "higher";
  const isLower = association.direction === "lower";

  return (
    <div
      className="grid gap-2 py-3 sm:grid-cols-[10rem_minmax(0,1fr)_6rem] sm:items-center sm:gap-3"
      data-testid="readiness-association-bar"
      data-tone="neutral"
    >
      <div className="min-w-0 sm:text-right">
        <span className="text-xs text-foreground">{label}</span>
        <span className="text-[10px] text-dim ml-1">({category})</span>
        <span className="block text-[10px] text-dim">
          Yes n = {yesCount} · No n = {noCount}
        </span>
        <ProviderSourceDetails sources={sources} />
      </div>
      <div className="flex min-w-0 items-center">
        {/* Lower relative difference */}
        <div className="flex-1 flex justify-end">
          {isLower && (
            <div
              className="h-5 rounded-l bg-blue-500 transition-all"
              style={{ width: `${(barWidth / maxBar) * 100}%` }}
            />
          )}
        </div>
        {/* Center line */}
        <div className="w-px bg-border-strong h-7 mx-1 shrink-0" />
        {/* Higher relative difference */}
        <div className="flex-1">
          {isHigher && (
            <div
              className="h-5 rounded-r bg-blue-500 transition-all"
              style={{ width: `${(barWidth / maxBar) * 100}%` }}
            />
          )}
        </div>
      </div>
      <div className="sm:text-right">
        <span className="text-xs font-medium text-blue-300">
          Estimate: {association.estimateLabel}
        </span>
      </div>
    </div>
  );
}

function ProviderSourceDetails({ sources }: { sources: ProviderProvenance[] }) {
  const [expanded, setExpanded] = useState(false);
  const sourceNames = sources.map((source) => source.label).join(", ");
  const sourceIds = sources.map((source) => source.providerId).join(", ");
  const sourcePrefix = sources.length === 1 ? "Source" : "Sources";
  const idPrefix = sources.length === 1 ? "Provider ID" : "Provider IDs";
  const action = expanded ? "Hide" : "Show";

  return (
    <span className="block text-[10px] text-dim">
      <span>
        {sourcePrefix}: {sourceNames}
      </span>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${action} technical source details for ${sourceNames}`}
        className="ml-1 text-subtle underline decoration-dotted underline-offset-2 hover:text-muted"
        onClick={() => setExpanded((current) => !current)}
      >
        Technical details
      </button>
      {expanded && (
        <span className="block">
          {idPrefix}: {sourceIds}
        </span>
      )}
    </span>
  );
}

export function BehaviorImpactChart({ days }: { days: TimeRangeDays }) {
  const { data, isLoading, error } = trpc.behaviorImpact.impactSummary.useQuery(
    selectedRangeQueryInput(days),
  );

  if (isLoading && !data) {
    return (
      <div className="card p-6 animate-pulse">
        <div className="h-4 bg-surface-hover rounded w-48 mb-4" />
        <div className="space-y-3">
          <div className="h-5 bg-surface-hover rounded" />
          <div className="h-5 bg-surface-hover rounded" />
          <div className="h-5 bg-surface-hover rounded" />
          <div className="h-5 bg-surface-hover rounded" />
        </div>
      </div>
    );
  }

  if (error && !data) {
    return <QueryStatePanel contextLabel="Behavior associations" error={error} height={120} />;
  }

  if (!data || data.length === 0) {
    return (
      <div className="card p-6">
        <h3 className="text-sm font-medium text-muted uppercase tracking-wider mb-2">
          Behavior Associations
        </h3>
        <p className="text-xs text-dim">
          Not enough journal data yet. Log boolean journal entries (Yes/No) for at least 5 days in
          each group to describe their association with next-day readiness.
        </p>
      </div>
    );
  }

  const evidence = data.find((item) => item.association)?.association;

  return (
    <div className="space-y-3">
      {error && <QueryStatePanel contextLabel="Behavior associations" error={error} height={96} />}
      <div className="card p-6">
        <h3 className="text-sm font-medium text-muted uppercase tracking-wider mb-2">
          Association with Next-Day Readiness
        </h3>
        {evidence ? (
          <EvidenceDetails
            className="mb-4"
            textClassName="text-dim"
            details={[
              { key: "method", label: "Method", value: evidence.method },
              {
                key: "interpretation",
                label: "Interpretation",
                value: evidence.interpretation,
              },
              {
                key: "uncertainty",
                label: "Uncertainty",
                value: evidence.uncertainty,
              },
              {
                key: "observation-window",
                label: "Observation window",
                value: evidence.observationWindow,
              },
            ]}
          />
        ) : null}
        <div
          className="mb-1 hidden text-[10px] text-dim sm:grid sm:grid-cols-[10rem_minmax(0,1fr)_6rem] sm:gap-3"
          data-testid="readiness-association-axis"
        >
          <span />
          <div className="flex items-center justify-between">
            <span>LOWER</span>
            <span>HIGHER</span>
          </div>
          <span />
        </div>
        <div className="divide-y divide-border">
          {data.map((item) =>
            item.association ? (
              <ReadinessAssociationBar
                key={item.questionSlug}
                label={item.displayName}
                readinessDifferencePercent={item.impactPercent}
                category={item.category}
                yesCount={item.yesCount}
                noCount={item.noCount}
                sources={item.sources}
                association={item.association}
              />
            ) : null,
          )}
        </div>
      </div>
    </div>
  );
}
