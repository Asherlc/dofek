import type { InsightEvidence } from "dofek-server/types";

type InsightEvidenceDetailFields = Pick<
  InsightEvidence,
  "method" | "interpretation" | "limitations" | "recommendation"
>;

interface InsightEvidenceDetailsProps {
  evidence: Partial<InsightEvidenceDetailFields>;
  className?: string;
}

export function InsightEvidenceDetails({ evidence, className }: InsightEvidenceDetailsProps) {
  const details = [
    { key: "method", value: evidence.method },
    { key: "interpretation", value: evidence.interpretation },
    { key: "limitations", value: evidence.limitations },
    { key: "recommendation", value: evidence.recommendation },
  ].filter(
    (entry): entry is { key: string; value: string } =>
      typeof entry.value === "string" && entry.value.trim().length > 0,
  );

  if (details.length === 0) return null;

  const rootClassName = ["space-y-1 text-xs text-muted", className]
    .filter((value): value is string => Boolean(value))
    .join(" ");

  return (
    <div className={rootClassName}>
      {details.map(({ key, value }) => (
        <p key={key}>{value}</p>
      ))}
    </div>
  );
}
