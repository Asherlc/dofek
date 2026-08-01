import type { InsightEvidence } from "dofek-server/types";
import { EvidenceDetails } from "./EvidenceDetails.tsx";

type InsightEvidenceDetailFields = Pick<
  InsightEvidence,
  "method" | "interpretation" | "limitations" | "recommendation" | "observationWindow"
>;

interface InsightEvidenceDetailsProps {
  evidence: Partial<InsightEvidenceDetailFields>;
  className?: string;
}

export function InsightEvidenceDetails({ evidence, className }: InsightEvidenceDetailsProps) {
  return (
    <EvidenceDetails
      details={[
        { key: "method", value: evidence.method },
        { key: "interpretation", value: evidence.interpretation },
        { key: "limitations", value: evidence.limitations },
        { key: "recommendation", value: evidence.recommendation },
        {
          key: "observation-window",
          label: "Observation window",
          value: evidence.observationWindow,
        },
      ]}
      className={className}
    />
  );
}
