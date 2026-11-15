import { formatDateMedium, formatNumber } from "@dofek/format/format";
import type { CyclingThresholdEvidence } from "../../../server/src/contracts/cycling-threshold.ts";

export function CyclingThresholdDetails({ evidence }: { evidence: CyclingThresholdEvidence }) {
  if (evidence.unavailable_reason) {
    return (
      <p className="text-sm text-muted" role="status">
        {evidence.unavailable_reason}
      </p>
    );
  }

  return (
    <div className="mb-3 text-sm text-muted">
      {evidence.value != null && <p>Applied FTP: {formatNumber(evidence.value, 0)} W</p>}
      {evidence.effective_from ? (
        <p>Effective from {formatDateMedium(evidence.effective_from)}</p>
      ) : null}
    </div>
  );
}
