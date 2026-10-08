import { useId, useState } from "react";
import type { ActivitySourceDecisionDetail } from "../../../server/src/models/activity-source-decision.ts";

interface ActivitySourceDecisionCardProps {
  decision: ActivitySourceDecisionDetail;
}

/** Discloses the source count and primary source for a multi-source activity. */
export function ActivitySourceDecisionCard({ decision }: ActivitySourceDecisionCardProps) {
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-1">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((value) => !value)}
        className="flex items-center gap-1 py-1 text-xs text-subtle hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        How sources were combined
      </button>
      <dl
        id={detailsId}
        hidden={!expanded}
        className={expanded ? "mt-2 flex flex-wrap gap-4 text-xs" : undefined}
      >
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-subtle">Sources</dt>
          <dd className="mt-0.5 text-foreground tabular-nums">{decision.sourceCount}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-subtle">Primary</dt>
          <dd className="mt-0.5 text-foreground">{decision.primarySourceLabel}</dd>
        </div>
      </dl>
    </div>
  );
}
