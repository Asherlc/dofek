import type { TodayPlanResult } from "@dofek/scoring/today-plan";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

const confidenceLabel: Record<TodayPlanResult["confidence"], string> = {
  high: "High confidence",
  moderate: "Moderate confidence",
  low: "Low confidence",
};

export interface TodayPlanCardProps {
  plan?: TodayPlanResult | null;
  loading?: boolean;
  error?: unknown;
}

function freshnessSummary(plan: TodayPlanResult): string | null {
  const parts: string[] = [];
  if (plan.freshness.recoveryDate != null) {
    parts.push(`Recovery data from ${plan.freshness.recoveryDate}`);
  }
  if (plan.freshness.sleepDate != null) {
    parts.push(`Sleep data from ${plan.freshness.sleepDate}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function TodayPlanCard({ plan, loading = false, error }: TodayPlanCardProps) {
  if (loading && plan == null) {
    return (
      <section className="card p-4 space-y-3" aria-label="Today Plan">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Today Plan</h2>
        <QueryStatePanel variant="loading" height={120} />
      </section>
    );
  }

  if (error != null && plan == null) {
    return (
      <section className="card p-4 space-y-3" aria-label="Today Plan">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Today Plan</h2>
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
      <section className="card p-4 space-y-3" aria-label="Today Plan">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Today Plan</h2>
        {refreshWarning}
        <p className="text-sm text-foreground leading-snug">{plan.message}</p>
        <p className="text-[11px] text-dim">{confidenceLabel[plan.confidence]}</p>
      </section>
    );
  }

  const freshness = freshnessSummary(plan);

  return (
    <section className="card p-4 space-y-3" aria-label="Today Plan">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Today Plan</h2>
        <span className="shrink-0 text-[10px] px-2 py-0.5 rounded border border-border-strong text-muted uppercase">
          {plan.action.zone}
        </span>
      </div>
      {refreshWarning}
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground leading-snug">{plan.action.title}</p>
        <p className="text-xs text-muted leading-snug">{plan.action.summary}</p>
      </div>
      <dl className="grid grid-cols-2 gap-3">
        {plan.supportingFacts.map((fact) => (
          <div key={fact.label} className="space-y-0.5">
            <dt className="text-[11px] text-dim">{fact.label}</dt>
            <dd className="text-sm text-foreground font-medium">{fact.value}</dd>
          </div>
        ))}
      </dl>
      <div className="space-y-1">
        <p className="text-[11px] text-dim">{confidenceLabel[plan.confidence]}</p>
        {freshness != null ? <p className="text-[11px] text-dim">{freshness}</p> : null}
      </div>
    </section>
  );
}
