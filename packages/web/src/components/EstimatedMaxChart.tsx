import { formatDateMedium, formatDateShort } from "@dofek/format/format";
import { formatMeasurementText, UnitConverter } from "@dofek/format/units";
import { TRAINING_TERMINOLOGY } from "@dofek/training/terminology";
import {
  isSameStrengthExercise,
  type StrengthExerciseIdentity,
  strengthExerciseDisplayLabels,
  strengthExerciseIdentityKey,
} from "@dofek/training/training";
import type { StrengthExerciseHistoryRow } from "dofek-server/types";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { dofekAxis, dofekGrid, dofekSeries, dofekTooltip, seriesColor } from "../lib/chartTheme.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { DofekChart } from "./DofekChart.tsx";
import { MethodExplanation } from "./MethodExplanation.tsx";

const SOURCE_WEIGHT_LABELS = {
  KG: new UnitConverter("metric").weightLabel,
  LBS: new UnitConverter("imperial").weightLabel,
} as const;
const ACSM_POSITION_STAND_URL = "https://pmc.ncbi.nlm.nih.gov/articles/PMC12965823/#T6";

type ExerciseOrderEvidence = NonNullable<StrengthExerciseHistoryRow["exerciseOrder"]>;
type ExerciseOrderSession = ExerciseOrderEvidence["baseline"];

interface EstimatedMaxChartProps {
  exercises: StrengthExerciseHistoryRow[];
  loading?: boolean;
}

export function EstimatedMaxChart({ exercises, loading }: EstimatedMaxChartProps) {
  const units = useUnitConverter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIdentity, setSelectedIdentity] = useState<StrengthExerciseIdentity | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const panelId = useId();

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const exerciseLabels = strengthExerciseDisplayLabels(exercises);
  const labelFor = (index: number) =>
    exerciseLabels[index]?.label ?? exercises[index]?.exerciseName ?? "";

  const selectedIndex = selectedIdentity
    ? exercises.findIndex((exercise) => isSameStrengthExercise(exercise, selectedIdentity))
    : -1;
  const selectedRowIndex = selectedIndex === -1 ? 0 : selectedIndex;
  const selected = exercises[selectedRowIndex];
  const selectedLabel = selected ? labelFor(selectedRowIndex) : null;
  const estimate = selected?.estimatedStrength ?? null;

  const normalizedQuery = query.trim().toLowerCase();
  const matchingIndexes = exercises
    .map((_, index) => index)
    .filter((index) => labelFor(index).toLowerCase().includes(normalizedQuery));

  const series = estimate
    ? [
        {
          ...dofekSeries.line(
            selectedLabel ?? estimate.exerciseName,
            estimate.history.map((historyEntry) => [
              historyEntry.date,
              units.convertWeight(historyEntry.estimatedMax),
            ]),
            {
              color: seriesColor(selectedRowIndex),
              smooth: false,
              symbol: "circle",
              symbolSize: 5,
            },
          ),
          smooth: 0.3,
          connectNulls: true,
        },
      ]
    : [];

  const option = {
    grid: dofekGrid("single", { top: 24, bottom: 48, left: 50 }),
    tooltip: dofekTooltip({
      trigger: "item",
      formatter: ({ dataIndex }: { dataIndex: number }) => {
        const point = estimate?.history[dataIndex];
        if (!point) return "";
        const estimateText = formatMeasurementText(units.formatWeight(point.estimatedMax));
        const loadText = formatMeasurementText(units.formatWeight(point.actualWeight));
        return [
          formatDateShort(point.date),
          `Estimated single-rep strength · ${estimateText}`,
          `Recorded set · ${loadText} × ${point.actualReps}`,
          `Strong set tag · ${point.fatigueMarker}`,
        ].join("<br/>");
      },
    }),
    xAxis: dofekAxis.time({
      axisLabel: {
        hideOverlap: true,
        showMinLabel: true,
        showMaxLabel: true,
      },
    }),
    yAxis: dofekAxis.value({
      name: `${TRAINING_TERMINOLOGY.estimatedOneRepMax.plainLabel} (${units.weightLabel})`,
    }),
    series,
  };

  function closeSelector() {
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  }

  function handleEscape(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") closeSelector();
  }

  return (
    <div>
      {exercises.length > 0 ? (
        <div className="relative mb-3">
          <button
            ref={triggerRef}
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => (open ? closeSelector() : setOpen(true))}
            onKeyDown={handleEscape}
            className="flex w-full items-center justify-between gap-2 rounded-lg border border-border-strong bg-accent/5 px-3 py-1.5 text-left text-xs text-foreground"
          >
            <span className="text-muted">Exercise</span>
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{selectedLabel}</span>
              <span
                aria-hidden="true"
                className={`text-muted transition-transform ${open ? "rotate-180" : ""}`}
              >
                ▾
              </span>
            </span>
          </button>
          {open ? (
            <div
              id={panelId}
              className="mt-2 rounded-lg border border-border-strong bg-surface p-2"
            >
              <input
                ref={searchRef}
                type="search"
                aria-label="Search exercises"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleEscape}
                placeholder="Search exercises"
                className="mb-2 w-full rounded-md border border-border-strong bg-background px-2 py-1 text-xs"
              />
              {matchingIndexes.length === 0 ? (
                <p className="px-2 py-1 text-xs text-muted">No exercises match “{query}”.</p>
              ) : (
                <div className="flex max-h-56 flex-col overflow-y-auto">
                  {matchingIndexes.map((index) => {
                    const exercise = exercises[index];
                    if (!exercise) return null;
                    const isSelected = index === selectedRowIndex;
                    return (
                      <button
                        key={strengthExerciseIdentityKey(exercise)}
                        type="button"
                        aria-pressed={isSelected}
                        onKeyDown={handleEscape}
                        onClick={() => {
                          setSelectedIdentity({
                            exerciseName: exercise.exerciseName,
                            equipment: exercise.equipment,
                          });
                          closeSelector();
                        }}
                        className={`rounded-md px-2 py-1.5 text-left text-xs ${
                          isSelected
                            ? "bg-accent/10 text-foreground"
                            : "text-muted hover:bg-surface-hover hover:text-foreground"
                        }`}
                      >
                        {labelFor(index)}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {selected?.exerciseOrder && selectedLabel ? (
        <OrderCallout
          key={strengthExerciseIdentityKey(selected)}
          label={selectedLabel}
          evidence={selected.exerciseOrder}
        />
      ) : null}
      {estimate ? (
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-xs text-muted" aria-live="polite">
            <span>{estimate.trend.summary}</span>{" "}
            <span className="font-mono tabular-nums text-foreground">
              {formatMeasurementText(units.formatWeight(estimate.trend.changeMagnitudeKg))}
            </span>
          </p>
          <p className="text-xs text-dim tabular-nums">
            {formatDateShort(estimate.trend.firstDate)} –{" "}
            {formatDateShort(estimate.trend.latestDate)}
          </p>
        </div>
      ) : null}
      <DofekChart
        option={option}
        loading={loading}
        empty={!estimate}
        emptyMessage="A trend needs three workouts with qualifying sets and recorded fatigue."
        height={280}
      />
      <MethodExplanation
        className="mt-2"
        technicalName={TRAINING_TERMINOLOGY.estimatedOneRepMax.technicalName}
        lines={[TRAINING_TERMINOLOGY.estimatedOneRepMax.details]}
      />
    </div>
  );
}

function OrderCallout({ label, evidence }: { label: string; evidence: ExerciseOrderEvidence }) {
  const latest = evidence.earlier ?? evidence.baseline;
  const sessions = evidence.earlier ? [evidence.baseline, evidence.earlier] : [evidence.baseline];
  const setNumbers = [
    ...new Set(sessions.flatMap((session) => session.sets.map((set) => set.position))),
  ].sort((a, b) => a - b);
  return (
    <section
      aria-label="Exercise order evidence"
      className="mb-3 rounded-lg border border-border-strong bg-accent/5 p-3 text-xs"
    >
      <p className="text-foreground">
        {label} was logged as exercise {latest.position} on {formatDateMedium(latest.date)} in the
        Crimpd log
        {evidence.earlier
          ? `, earlier than exercise ${evidence.baseline.position} on ${formatDateMedium(evidence.baseline.date)}`
          : ""}
        .
      </p>
      <p className="mt-1 text-muted">
        If getting stronger at {label} is a priority,{" "}
        {latest.position === 1 ? "keep it first" : "try it first"} after warm-up.
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer text-muted">Set details</summary>
        <table aria-label="Set-number comparison" className="mt-2 w-full text-left text-muted">
          <thead>
            <tr>
              <th scope="col">Set</th>
              {sessions.map((session) => (
                <th key={session.activityId} scope="col" className="font-normal text-foreground">
                  {formatDateMedium(session.date)} · exercise {session.position}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {setNumbers.map((setNumber) => (
              <tr key={setNumber}>
                <th scope="row" className="font-normal">
                  {setNumber}
                </th>
                {sessions.map((session) => (
                  <td key={session.activityId} className="tabular-nums">
                    {formatSetCell(session, setNumber)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-dim">
          Loads are shown as recorded by Crimpd. Rest and effort may differ between sessions. See
          the{" "}
          <a className="underline" href={ACSM_POSITION_STAND_URL}>
            ACSM position stand
          </a>
          .
        </p>
      </details>
    </section>
  );
}

function formatSetCell(session: ExerciseOrderSession, setNumber: number): string {
  const set = session.sets.find((candidate) => candidate.position === setNumber);
  if (!set) return "Not recorded";
  return `${set.resistance} ${SOURCE_WEIGHT_LABELS[set.unit]} × ${set.reps}`;
}
