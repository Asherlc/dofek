import { useId } from "react";
import type { ActivitySourceDecisionDetail } from "../../../server/src/models/activity-source-decision.ts";

interface ActivitySourceDecisionCardProps {
  decision: ActivitySourceDecisionDetail;
}

/** Renders the server-authored explanation of how multi-source activity records were combined. */
export function ActivitySourceDecisionCard({ decision }: ActivitySourceDecisionCardProps) {
  const headingId = useId();

  return (
    <section
      className="mb-4 rounded-lg border border-border bg-surface p-4"
      aria-labelledby={headingId}
    >
      <h2 id={headingId} className="text-sm font-semibold text-foreground">
        How sources were combined
      </h2>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-subtle">Sources</dt>
          <dd className="mt-0.5 text-foreground tabular-nums">{decision.sourceCount}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-subtle">Primary</dt>
          <dd className="mt-0.5 text-foreground">{decision.primarySourceLabel}</dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-subtle">{decision.explanation}</p>
    </section>
  );
}
