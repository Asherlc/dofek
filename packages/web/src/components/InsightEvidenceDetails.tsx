import type { InsightEvidence } from "dofek-server/types";
import { EvidenceDetails } from "./EvidenceDetails.tsx";

type InsightEvidenceDetailFields = Pick<
  InsightEvidence,
  "method" | "limitations" | "observationWindow"
>;

interface InsightEvidenceDetailsProps {
  evidence: Partial<InsightEvidenceDetailFields>;
  className?: string;
}

export function InsightEvidenceDetails({ evidence, className }: InsightEvidenceDetailsProps) {
  if (
    ![evidence.method, evidence.limitations, evidence.observationWindow].some((value) =>
      value?.trim(),
    )
  )
    return null;

  return (
    <div className={className}>
      <EvidenceDetails details={[{ key: "limitations", value: evidence.limitations }]} />
      <details className="mt-2 text-xs text-muted">
        <summary className="cursor-pointer">Calculation details</summary>
        <EvidenceDetails
          details={[
            { key: "method", value: evidence.method },
            {
              key: "observation-window",
              label: "Observation window",
              value: evidence.observationWindow,
            },
          ]}
        />
      </details>
    </div>
  );
}
