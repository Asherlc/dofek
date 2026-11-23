import { formatDateMedium } from "@dofek/format/format";
import { formatMeasurementText } from "@dofek/format/units";
import { providerLabel } from "@dofek/providers/providers";
import { useState } from "react";
import type { StrengthProgressionRow } from "../lib/training-progression.ts";
import { useUnitConverter } from "../lib/unitContext.ts";

/**
 * Dated recorded sets behind a disclosure. Reused by the Home summary and the
 * Strength card details slot so neither route copies evidence rows.
 */
export function StrengthProgressionEvidence({ row }: { row: StrengthProgressionRow }) {
  const units = useUnitConverter();
  const [open, setOpen] = useState(false);
  const observations = [...row.evidence.observations].sort((left, right) =>
    right.date.localeCompare(left.date),
  );
  return (
    <div className="text-sm">
      <button
        type="button"
        aria-expanded={open}
        className="cursor-pointer text-accent"
        onClick={() => setOpen(!open)}
      >
        See recorded sets
      </button>
      {open ? (
        <>
          {row.evidence.kind === "flat_benchmark" ? (
            <p className="text-muted">
              Estimated one-rep max range:{" "}
              {formatMeasurementText(units.formatWeight(row.evidence.observedRangeKg.min))} –{" "}
              {formatMeasurementText(units.formatWeight(row.evidence.observedRangeKg.max))}
            </p>
          ) : null}
          <ul className="mt-2 space-y-1 text-muted">
            {observations.map((observation) => (
              <li key={observation.sourceSetId}>
                {formatDateMedium(observation.date, { timeZone: "UTC" })} · {observation.reps} reps
                at {formatMeasurementText(units.formatWeight(observation.weightKg))}
                {observation.rpe !== null ? ` · Effort ${observation.rpe}/10` : null} ·{" "}
                {providerLabel(observation.provider)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
