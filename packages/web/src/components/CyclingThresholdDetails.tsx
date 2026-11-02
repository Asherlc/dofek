import { formatDateLong, formatDurationSeconds, formatNumber } from "@dofek/format/format";
import type { CyclingThresholdEvidence } from "../../../server/src/contracts/cycling-threshold.ts";

export function CyclingThresholdDetails({ evidence }: { evidence: CyclingThresholdEvidence }) {
  if (evidence.unavailable_reason)
    return (
      <p className="text-sm text-muted" role="status">
        {evidence.unavailable_reason}
      </p>
    );
  return (
    <div className="mb-3 text-sm text-muted">
      {evidence.value != null && <p>Computed eFTP: {formatNumber(evidence.value, 0)} W</p>}
      {evidence.evidence_at != null &&
        evidence.evidence_duration_seconds != null &&
        evidence.evidence_power != null && (
          <p>
            Evidence: {formatDurationSeconds(evidence.evidence_duration_seconds)} at{" "}
            {formatNumber(evidence.evidence_power, 0)} W on{" "}
            {formatDateLong(evidence.evidence_at, { timeZone: "UTC" })}.
          </p>
        )}
      <details className="mt-2">
        <summary className="cursor-pointer">Estimate uncertainty</summary>
        <p className="mt-1">eFTP means estimated functional threshold power.</p>
        <p className="mt-1">{evidence.uncertainty.reason}</p>
      </details>
    </div>
  );
}
