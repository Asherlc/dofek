import { providerLabel } from "@dofek/providers/providers";
import type {
  ClimbingStrengthsCell,
  ClimbingStrengthsDisplayPanel,
  ClimbingStrengths as Strengths,
} from "@dofek/training/climbing-strengths";
import {
  ALL_CLIMBING_GRADES,
  climbingStrengthsAdjustedLabel,
  climbingStrengthsCountLabel,
  climbingStrengthsGradePanel,
  climbingStrengthsRateLabel,
  climbingStrengthsResultLabel,
  climbingStrengthsSendLabel,
} from "@dofek/training/climbing-strengths";
import {
  climbingStrengthsBreakdownKey,
  climbingStrengthsBreakdownOptions,
  climbingStrengthsDefaultBreakdown,
  climbingStrengthsPanelLabel,
  climbingStrengthsObserved as observed,
} from "@dofek/training/climbing-strengths-presentation";
import {
  CLIMBING_STRENGTHS_TABS,
  type ClimbingStrengthsTab,
} from "@dofek/training/climbing-strengths-views";
import { useState } from "react";
import { ClimbingStrengthsChart } from "./ClimbingStrengthsChart.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

function rateLabel(cell: ClimbingStrengthsCell) {
  return climbingStrengthsRateLabel(cell);
}

export function ClimbingStrengths({
  data,
  loading,
}: {
  data: Strengths | undefined;
  loading?: boolean;
}) {
  const [view, setView] = useState<ClimbingStrengthsTab>("radar");
  const [selectedBreakdown, setBreakdown] = useState<string | null>(null);
  const panels = [...(data?.panels ?? []), ...(data?.tagPanels ?? [])];
  const options = climbingStrengthsBreakdownOptions(panels);
  const breakdown = options.some((option) => option.key === selectedBreakdown)
    ? (selectedBreakdown ?? "wall_angle")
    : climbingStrengthsDefaultBreakdown(panels);
  const breakdownLabel = options.find((option) => option.key === breakdown)?.label ?? "Wall angle";
  if (!data && loading)
    return <QueryStatePanel variant="loading" contextLabel="Climbing strengths" />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <fieldset className="flex flex-wrap gap-2">
          <legend className="mb-2 text-xs text-muted">Break down by</legend>
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              aria-pressed={breakdown === option.key}
              className={
                "min-h-10 rounded-lg border px-3 text-sm " +
                (breakdown === option.key
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border text-muted")
              }
              onClick={() => setBreakdown(option.key)}
            >
              {option.providerId ? `${providerLabel(option.providerId)} · ` : ""}
              {option.label}
            </button>
          ))}
        </fieldset>
      </div>
      <fieldset aria-label="Strengths view" className="flex gap-6 border-b border-border">
        {CLIMBING_STRENGTHS_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            aria-pressed={view === tab.value}
            onClick={() => setView(tab.value)}
            className={`min-h-11 border-b-2 pb-3 text-sm ${view === tab.value ? "border-accent font-medium text-accent" : "border-transparent text-muted"}`}
          >
            {tab.label}
          </button>
        ))}
      </fieldset>
      {!panels.length ? (
        <QueryStatePanel variant="empty" message="No recorded climbing strengths in this period." />
      ) : null}
      {panels.some((panel) => panel.grades.some((grade) => grade.unknownOutcomes > 0)) ? (
        <p className="text-xs text-muted">Success rates use climbs with known results.</p>
      ) : null}
      {panels.length > 0 ? (
        <ClimbingStrengthsBreakdown
          panels={panels}
          breakdown={breakdown}
          label={breakdownLabel}
          view={view}
        />
      ) : null}
    </div>
  );
}

function ClimbingStrengthsBreakdown({
  panels,
  breakdown,
  label,
  view,
}: {
  panels: ClimbingStrengthsDisplayPanel[];
  breakdown: string;
  label: string;
  view: ClimbingStrengthsTab;
}) {
  const selectedPanels = panels.filter(
    (panel) => climbingStrengthsBreakdownKey(panel) === breakdown,
  );
  return (
    <section className="space-y-3">
      {selectedPanels.length ? (
        selectedPanels.map((panel) => (
          <div key={panel.key} className="min-w-0 space-y-3">
            <ClimbingStrengthsPanelContent panel={panel} view={view} />
          </div>
        ))
      ) : (
        <QueryStatePanel
          variant="empty"
          message={`No recorded ${label.toLowerCase()} observations for this context.`}
        />
      )}
    </section>
  );
}

function ClimbingStrengthsPanelContent({
  panel,
  view,
}: {
  panel: ClimbingStrengthsDisplayPanel;
  view: ClimbingStrengthsTab;
}) {
  const [selected, setSelected] = useState<{ row: string; grade: string } | null>(null);
  const displayPanel = climbingStrengthsGradePanel(panel, ALL_CLIMBING_GRADES);
  const row = displayPanel.rows.find((item) => item.key === selected?.row);
  const cell = row?.cells.find((item) => item.grade === selected?.grade);
  return (
    <div className="space-y-3">
      {!observed(panel) ? (
        <QueryStatePanel
          variant="empty"
          message={
            panel.coverage.missingTraits > 0
              ? `${climbingStrengthsPanelLabel(panel)} is missing for ${panel.coverage.missingTraits} ${panel.coverage.missingTraits === 1 ? "climb" : "climbs"}.`
              : `No recorded ${climbingStrengthsPanelLabel(panel).toLowerCase()} observations for this context.`
          }
        />
      ) : (
        <>
          <h3 className="font-medium">
            {view === "radar" ? "Strengths and weaknesses" : "Monthly send rate"}
          </h3>
          <ClimbingStrengthsChart
            panel={displayPanel}
            view={view}
            grade={ALL_CLIMBING_GRADES}
            selectedRow={cell ? (row?.key ?? null) : null}
            onSelectCell={(row, grade) => setSelected({ row, grade })}
          />
        </>
      )}
      {cell && row ? (
        <section
          aria-label="Selected climbs"
          className="rounded-lg border border-border bg-surface p-4 space-y-3"
        >
          <h3 className="font-semibold">
            {row.label}
            {view === "radar" ? "" : ` · ${cell.grade}`}
          </h3>
          {view === "progress" ? (
            <p className="text-xs text-muted">
              Across the selected period · counts and source climbs apply to the whole period.
            </p>
          ) : null}
          <p>
            {view === "radar"
              ? climbingStrengthsSendLabel(cell)
              : `${rateLabel(cell)} · ${climbingStrengthsCountLabel(cell)}`}
          </p>
          {view === "radar" ? (
            <p className="text-xs text-muted">
              {climbingStrengthsAdjustedLabel(
                panel.gradeAdjustedStrengths.find((entry) => entry.key === row.key),
              )}
            </p>
          ) : null}
          {view !== "radar" && cell.differencePercentagePoints !== null ? (
            <p className="text-xs text-muted">
              {cell.differencePercentagePoints > 0 ? "+" : ""}
              {cell.differencePercentagePoints} percentage points vs{" "}
              {cell.grade === ALL_CLIMBING_GRADES ? "overall" : "same-grade"} baseline
            </p>
          ) : null}
          {cell.examples.map((example) => (
            <div key={example.logEntryId} className="border-t border-border pt-3 text-sm">
              <p className="font-medium">{example.name}</p>
              <p className="text-xs text-muted">
                {example.grade} · {example.date} · {climbingStrengthsResultLabel(example.outcome)}
              </p>
              <div className="mt-1 flex gap-3 text-xs text-accent">
                {example.sourceUrl ? (
                  <a href={example.sourceUrl} target="_blank" rel="noreferrer">
                    {example.sourceName}
                  </a>
                ) : (
                  <span className="text-muted">{example.sourceName}</span>
                )}
                {example.activityId ? (
                  <a href={`/activity/${example.activityId}`}>View activity</a>
                ) : null}
              </div>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}
