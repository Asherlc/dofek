import {
  formatRecordedDailyMetric,
  GARMIN_INTERVALS_DISCLOSURE,
  type RecordedDailyMetricRow,
  recordedMetricsNeedGarminDisclosure,
} from "@dofek/format/recorded-daily-metrics";
import { providerSourceLabel } from "@dofek/providers/providers";
import { useUnitConverter } from "../lib/unitContext.ts";

/** Provider-reported, date-only observations; the page owns the query and its error state. */
export function RecordedDailyMetrics({
  rows,
}: {
  rows: readonly RecordedDailyMetricRow[] | undefined;
}) {
  const units = useUnitConverter();
  if (!rows || rows.length === 0) return null;

  return (
    <section aria-label="Provider-reported observations" className="card p-2 sm:p-4 mb-4">
      <h4 className="mb-2 text-xs font-medium text-subtle uppercase">Provider-reported</h4>
      <ul className="space-y-1 text-sm">
        {rows.map((row) => {
          const formatted = formatRecordedDailyMetric(row, units);
          return (
            <li
              key={`${row.date}:${row.metric}:${row.providerId}`}
              className="flex flex-wrap items-baseline justify-between gap-x-3"
            >
              <span>
                <span className="text-subtle">{formatted.date}</span> {formatted.label}
              </span>
              <span>
                <span className="font-medium">{formatted.value}</span>{" "}
                <span className="text-xs text-subtle">
                  {providerSourceLabel(row.providerId, row.sourceName)}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      {recordedMetricsNeedGarminDisclosure(rows) && (
        <p className="mt-2 text-xs text-subtle">{GARMIN_INTERVALS_DISCLOSURE}</p>
      )}
    </section>
  );
}
