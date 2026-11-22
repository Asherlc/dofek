import { formatDateMedium } from "@dofek/format/format";
import type {
  ClimbingBestOnsightCell,
  ClimbingBestOnsight as ClimbingBestOnsightData,
} from "@dofek/training/climbing-best-onsight";
import { climbingTypeOptions } from "@dofek/training/climbing-filters";
import { useId, useState } from "react";
import { ProviderRecordDetail } from "../pages/ProviderRecordDetail.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

const climbingTypeLabels = Object.fromEntries(climbingTypeOptions);

const settings = [
  { key: "gym", label: "Gym" },
  { key: "outdoor", label: "Outdoor" },
] as const;

interface ClimbingBestOnsightProps {
  data?: ClimbingBestOnsightData;
  error?: unknown;
  loading?: boolean;
}

export function ClimbingBestOnsight({ data, error, loading }: ClimbingBestOnsightProps) {
  const [selected, setSelected] = useState<ClimbingBestOnsightCell | null>(null);
  const headingId = useId();

  if (!data) {
    if (loading) {
      return (
        <QueryStatePanel variant="loading" height={120} contextLabel="best recorded onsight" />
      );
    }
    return error ? <QueryStatePanel error={error} height={120} /> : null;
  }

  return (
    <div>
      <h2 id={headingId} className="mb-1 text-sm font-medium uppercase tracking-wider text-muted">
        Best recorded onsight
      </h2>
      <p className="mb-3 text-xs text-dim">
        Past 12 months · {formatDateMedium(data.startDate, { timeZone: "UTC" })}–
        {formatDateMedium(data.endDate, { timeZone: "UTC" })}
      </p>
      {error ? <QueryStatePanel error={error} height={0} /> : null}
      <table aria-labelledby={headingId} className="w-full border-collapse text-left text-sm">
        <thead>
          <tr>
            <th scope="col" className="px-3 py-2 font-semibold">
              Climbing type
            </th>
            {settings.map(({ label }) => (
              <th key={label} scope="col" className="px-3 py-2 font-semibold">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => {
            const typeLabel = climbingTypeLabels[row.type];
            return (
              <tr key={row.type} className="border-t border-border">
                <th scope="row" className="px-3 py-2 font-medium">
                  {typeLabel}
                </th>
                {settings.map(({ key, label }) => {
                  const cell = row[key];
                  return (
                    <td
                      key={key}
                      className="px-3 py-2"
                      aria-label={cell ? undefined : `No recorded ${label} ${typeLabel} onsight`}
                    >
                      {cell ? (
                        <button
                          type="button"
                          aria-label={`${cell.grade}, open ${label} ${typeLabel} send`}
                          onClick={() => setSelected(cell)}
                          className="rounded text-accent underline underline-offset-2"
                        >
                          {cell.grade}
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {selected ? (
        <ProviderRecordDetail
          input={{
            providerId: selected.providerId,
            dataType: "climbingLogEntries",
            recordId: selected.recordId,
          }}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}
