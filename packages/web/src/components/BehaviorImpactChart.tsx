import { formatAssociationEstimateLabel } from "@dofek/format/format";
import type { ProviderProvenance } from "@dofek/providers/providers";
import type { BehaviorAssociation } from "dofek-server/types";
import { useState } from "react";
import { selectedRangeQueryInput, type TimeRangeDays } from "../lib/timeRange.ts";
import { trpc } from "../lib/trpc.ts";
import { EvidenceDetails } from "./EvidenceDetails.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

const NO_ASSOCIATION_EVIDENCE_MESSAGE =
  "No association evidence is available for the current results. Log boolean journal entries (Yes/No) for at least 5 days in each group to describe their association with next-day readiness.";

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
          {formatAssociationEstimateLabel(association.estimateLabel)}
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
  const { data, isLoading, isFetching, error, refetch } =
    trpc.behaviorImpact.impactSummary.useQuery(selectedRangeQueryInput(days), {
      placeholderData: (previousData) => previousData,
    });

  if (isLoading && data === undefined) {
    return (
      <QueryStatePanel
        contextLabel="Behavior associations"
        variant="loading"
        message="Loading behavior associations."
        height={120}
      />
    );
  }

  if (error && data === undefined) {
    return (
      <QueryStatePanel
        contextLabel="Behavior associations"
        error={error}
        height={120}
        onRetry={() => void refetch()}
        retryLabel="Retry behavior associations"
        retrying={isFetching}
      />
    );
  }

  const refreshStatus = isFetching ? (
    <output
      className="text-xs text-dim"
      aria-label="Refreshing behavior associations."
      aria-live="polite"
      aria-busy="true"
    >
      Refreshing behavior associations…
    </output>
  ) : null;

  const refreshError = error ? (
    <QueryStatePanel
      contextLabel="Behavior associations"
      error={error}
      height={96}
      onRetry={() => void refetch()}
      retryLabel="Retry behavior associations"
      retrying={isFetching}
    />
  ) : null;

  if (data === undefined || data.length === 0) {
    return (
      <div className="space-y-3">
        {refreshStatus}
        {refreshError}
        <QueryStatePanel
          contextLabel="Behavior associations"
          variant="empty"
          message="Not enough journal data yet. Log boolean journal entries (Yes/No) for at least 5 days in each group to describe their association with next-day readiness."
          height={120}
        />
      </div>
    );
  }

  const associationRows = data.filter((item) => item.association);
  if (associationRows.length === 0) {
    return (
      <div className="space-y-3">
        {refreshStatus}
        {refreshError}
        <div className="card p-6">
          <h3 className="text-sm font-medium text-muted uppercase tracking-wider mb-2">
            Association evidence unavailable
          </h3>
          <p className="text-xs text-dim">{NO_ASSOCIATION_EVIDENCE_MESSAGE}</p>
        </div>
      </div>
    );
  }

  const evidence = associationRows[0]?.association;

  return (
    <div className="space-y-3">
      {refreshStatus}
      {refreshError}
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
          {associationRows.map((item) =>
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
