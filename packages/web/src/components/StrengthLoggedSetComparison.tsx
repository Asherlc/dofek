import { formatDateMedium } from "@dofek/format/format";
import { formatMeasurementText } from "@dofek/format/units";
import { providerLabel } from "@dofek/providers/providers";
import type { LoggedSetComparison } from "dofek-server/types";
import { useState } from "react";
import {
  type StrengthProgressionRow,
  strengthEvidenceSummary,
  strengthHeadline,
} from "../lib/training-progression.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { QueryStatePanel } from "./QueryStatePanel.tsx";
import { StrengthProgressionEvidence } from "./StrengthProgressionEvidence.tsx";
import { TrainingProgressionStatusCard } from "./TrainingProgressionStatusCard.tsx";
export function StrengthLoggedSetComparison({
  data,
  loading = false,
  error,
  progressionRows,
}: {
  data?: LoggedSetComparison;
  loading?: boolean;
  error?: { message: string } | null;
  progressionRows?: StrengthProgressionRow[];
}) {
  const units = useUnitConverter();
  const [exerciseKey, setExerciseKey] = useState<string | null>(null);
  const [reps, setReps] = useState<number | null>(null);
  const exercise =
    data?.exercises.find((item) => item.exerciseId === exerciseKey) ?? data?.exercises[0];
  const progressionRow = progressionRows?.find((row) => row.exerciseId === exercise?.exerciseId);
  const comparison =
    exercise?.comparisons.find((item) => item.reps === reps) ?? exercise?.comparisons[0];
  const weight = (value: number) => formatMeasurementText(units.formatWeight(value));
  return (
    <section className="card p-4 space-y-4">
      <h2 className="text-sm font-medium text-muted uppercase tracking-wider">
        Sets and performance
      </h2>
      {error ? <QueryStatePanel error={error} /> : null}
      {!data && loading ? <QueryStatePanel variant="loading" /> : null}
      {!loading && !error && !exercise ? (
        <QueryStatePanel message="No logged sets with load and reps in this period" />
      ) : null}
      {exercise ? (
        <>
          <div className="flex flex-wrap gap-3">
            {data && data.exercises.length > 1 ? (
              <select
                aria-label="Exercise and equipment"
                className="min-h-11 max-w-full rounded-lg bg-surface border border-border px-3"
                value={exercise.exerciseId}
                onChange={(event) => {
                  setExerciseKey(event.target.value);
                  setReps(null);
                }}
              >
                {data.exercises.map((item) => (
                  <option key={item.exerciseId} value={item.exerciseId}>
                    {item.exerciseName}
                    {item.equipment ? ` · ${item.equipment}` : ""}
                  </option>
                ))}
              </select>
            ) : (
              <h3>
                {exercise.exerciseName}
                {exercise.equipment ? ` · ${exercise.equipment}` : ""}
              </h3>
            )}
            {exercise.comparisons.length > 1 ? (
              <select
                aria-label="Rep count"
                className="min-h-11 max-w-full rounded-lg bg-surface border border-border px-3"
                value={comparison?.reps}
                onChange={(event) => setReps(Number(event.target.value))}
              >
                {exercise.comparisons.map((item) => (
                  <option key={item.reps} value={item.reps}>
                    {item.reps} reps
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          {progressionRow ? (
            <TrainingProgressionStatusCard
              status={progressionRow.status}
              headline={strengthHeadline(progressionRow)}
              summary={strengthEvidenceSummary(progressionRow)}
              details={<StrengthProgressionEvidence row={progressionRow} />}
            />
          ) : null}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-lg bg-surface p-3">
              <p>Logged sets with load and reps</p>
              <strong className="text-2xl">{exercise.totalLoggedSets}</strong>
              <p className="text-xs text-muted">
                Across {exercise.sessions.length} recorded sessions
              </p>
            </div>
            {comparison ? (
              <div className="rounded-lg bg-surface p-3">
                <p>Heaviest set of {comparison.reps} reps</p>
                <strong className="text-2xl">
                  {weight(comparison.first.weightKg)}
                  {comparison.latest ? ` → ${weight(comparison.latest.weightKg)}` : ""}
                </strong>
                <p className="text-xs text-muted">
                  {formatDateMedium(comparison.first.date, { timeZone: "UTC" })}
                  {comparison.latest
                    ? ` to ${formatDateMedium(comparison.latest.date, { timeZone: "UTC" })}`
                    : " · One recorded date"}
                </p>
              </div>
            ) : null}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Recorded sessions</caption>
              <thead>
                <tr>
                  <th scope="col" className="text-left">
                    Session
                  </th>
                  <th scope="col">Logged sets</th>
                  <th scope="col">Heaviest set{comparison ? ` of ${comparison.reps} reps` : ""}</th>
                  <th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                {exercise.sessions.map((session) => {
                  const observed = session.heaviestSets.find(
                    (item) => item.reps === comparison?.reps,
                  );
                  return (
                    <tr key={session.activityId} className="border-b border-border">
                      <th scope="row" className="py-2 text-left">
                        {formatDateMedium(session.date, { timeZone: "UTC" })}
                      </th>
                      <td className="text-center">{session.loggedSets}</td>
                      <td className="text-center">
                        {observed
                          ? weight(observed.weightKg)
                          : comparison
                            ? `No ${comparison.reps}-rep set`
                            : "No comparable rep observation"}
                      </td>
                      <td className="text-center">
                        {session.sourceProviders.map(providerLabel).join(", ")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {data ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-accent">About this comparison</summary>
          <p className="text-muted mt-2">
            {data.research.summary}{" "}
            <a
              href={data.research.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent"
            >
              Read the study
            </a>
          </p>
        </details>
      ) : null}
    </section>
  );
}
