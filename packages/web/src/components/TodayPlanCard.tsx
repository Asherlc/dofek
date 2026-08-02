import {
  formatTodayPlanConfidence,
  formatTodayPlanFreshness,
  type TodayPlanResult,
} from "@dofek/scoring/today-plan";
import { useState } from "react";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

export interface TodayPlanCardProps {
  plan?: TodayPlanResult | null;
  loading?: boolean;
  error?: unknown;
}

export function TodayPlanCard({ plan, loading = false, error }: TodayPlanCardProps) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  if (loading && plan == null) {
    return (
      <section className="card p-4 space-y-3" aria-label="What matters today">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
          What matters today
        </h2>
        <QueryStatePanel variant="loading" height={120} />
      </section>
    );
  }

  if (error != null && plan == null) {
    return (
      <section className="card p-4 space-y-3" aria-label="What matters today">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
          What matters today
        </h2>
        <QueryStatePanel error={error} height={120} />
      </section>
    );
  }

  if (plan == null) {
    return null;
  }

  const refreshWarning = error != null ? <QueryStatePanel error={error} height={72} /> : null;

  if (plan.status === "insufficient_data") {
    return (
      <section className="card p-4 space-y-3" aria-label="What matters today">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
          What matters today
        </h2>
        {refreshWarning}
        <p className="text-sm text-foreground leading-snug">{plan.message}</p>
        <p className="text-[11px] text-dim">{formatTodayPlanConfidence(plan.confidence)}</p>
      </section>
    );
  }

  const freshness = formatTodayPlanFreshness(plan.freshness);

  return (
    <section className="card p-4 space-y-3" aria-label="What matters today">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
          What matters today
        </h2>
        <span className="shrink-0 text-[10px] px-2 py-0.5 rounded border border-border-strong text-muted uppercase">
          {plan.action.zone}
        </span>
      </div>
      {refreshWarning}
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground leading-snug">{plan.action.title}</p>
        <p className="text-xs text-muted leading-snug">{plan.action.summary}</p>
      </div>
      <button
        type="button"
        className="w-fit text-xs text-link underline decoration-dotted underline-offset-2 hover:text-foreground"
        aria-expanded={evidenceOpen}
        aria-controls="today-plan-evidence"
        onClick={() => setEvidenceOpen((current) => !current)}
      >
        Why this?
      </button>
      {evidenceOpen ? (
        <div id="today-plan-evidence" className="space-y-2 rounded border border-border p-3">
          <h3 className="text-xs font-medium text-foreground">Contributing observations</h3>
          <dl className="grid grid-cols-2 gap-3">
            {plan.supportingFacts.map((fact) => (
              <div key={fact.label} className="space-y-0.5">
                <dt className="text-[11px] text-dim">{fact.label}</dt>
                <dd className="text-sm text-foreground font-medium">{fact.value}</dd>
              </div>
            ))}
          </dl>
          {plan.caveats.length > 0 ? (
            <div className="space-y-1">
              <h3 className="text-xs font-medium text-foreground">Caveats</h3>
              <ul className="list-disc space-y-1 pl-4 text-xs text-muted">
                {plan.caveats.map((caveat) => (
                  <li key={caveat}>{caveat}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="space-y-1">
        <p className="text-[11px] text-dim">{formatTodayPlanConfidence(plan.confidence)}</p>
        {freshness != null ? <p className="text-[11px] text-dim">{freshness}</p> : null}
      </div>
    </section>
  );
}
