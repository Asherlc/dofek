import {
  BODY_DECISION_CONTEXT_UNAVAILABLE,
  BODY_SOURCE_GUIDANCE,
  BODY_TREND_WEIGHT_DECISION_COPY,
  type BodyDecisionContextView,
  formatBodyDecisionProvenance,
  formatBodyDecisionVariation,
  formatSignedBodyResidual,
} from "@dofek/format/body-decision-context";
import { formatMeasurementText } from "@dofek/format/units";
import { providerLabel } from "@dofek/providers/providers";
import { useUnitConverter } from "../lib/unitContext.ts";

interface BodyDecisionContextProps {
  context: BodyDecisionContextView | null;
}

export function BodyDecisionContext({ context }: BodyDecisionContextProps) {
  const units = useUnitConverter();
  const formatWeight = (weightKg: number) => formatMeasurementText(units.formatWeight(weightKg));
  const provenance = formatBodyDecisionProvenance(context?.latestMeasurement ?? null, {
    formatWeight,
    providerLabel,
  });
  const variation = context
    ? formatBodyDecisionVariation(context.variation, (residualKg) =>
        formatSignedBodyResidual(residualKg, formatWeight),
      )
    : null;

  return (
    <section
      aria-label="Trend Weight decision context"
      className="mt-3 space-y-2 border-t border-border-subtle pt-3 text-xs leading-relaxed text-muted"
      data-testid="body-decision-context"
    >
      {context == null ? (
        <p>{BODY_DECISION_CONTEXT_UNAVAILABLE}</p>
      ) : (
        <>
          {provenance != null && <p>{provenance}</p>}
          <p>{BODY_TREND_WEIGHT_DECISION_COPY}</p>
          <p>{variation}</p>
          <p>{BODY_SOURCE_GUIDANCE}</p>
        </>
      )}
    </section>
  );
}
