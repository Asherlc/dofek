/** Display only: coverage and cadence values are supplied by the server. */
export function runningCadenceLabel(row: {
  cadenceBasis: "cadence_samples" | "step_intervals" | "unknown";
  cadenceCoveragePercent: number | null;
}): string {
  return row.cadenceBasis === "step_intervals"
    ? `Steps${row.cadenceCoveragePercent === null ? "" : ` · ${row.cadenceCoveragePercent}% coverage`}`
    : row.cadenceBasis === "cadence_samples"
      ? "Recorded cadence"
      : "Unknown basis";
}
