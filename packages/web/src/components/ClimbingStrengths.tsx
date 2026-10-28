import { climbingProgressionSettingLabels } from "@dofek/training/climbing-progression";
import type {
  ClimbingStrengthsCell,
  ClimbingStrengthsPanel,
  ClimbingStrengths as Strengths,
} from "@dofek/training/climbing-strengths";
import {
  ALL_CLIMBING_GRADES,
  climbingStrengthsCountLabel,
  climbingStrengthsDifferenceLabel,
  climbingStrengthsGradePanel,
  climbingStrengthsRateLabel,
  climbingStrengthsResultLabel,
} from "@dofek/training/climbing-strengths";
import {
  CLIMBING_STRENGTHS_TABS,
  type ClimbingStrengthsTab,
} from "@dofek/training/climbing-strengths-views";
import { useState } from "react";
import { ClimbingStrengthsChart } from "./ClimbingStrengthsChart.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

const dimensions = {
  wall_angle: "Wall angle",
  hold_type: "Hold type",
  setting: "Setting",
};
function observed(panel: ClimbingStrengthsPanel) {
  return panel.rows.some((row) => row.cells.some((cell) => cell.sampleStatus !== "no_data"));
}
function preferred(panels: ClimbingStrengthsPanel[]) {
  return (
    panels.find((panel) => panel.dimension === "wall_angle" && observed(panel)) ??
    panels.find((panel) => panel.dimension === "hold_type" && observed(panel)) ??
    panels.find((panel) => panel.dimension !== "setting")
  );
}
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
  const [selectedDimension, setDimension] = useState<ClimbingStrengthsPanel["dimension"] | null>(
    null,
  );
  const panels = data?.panels ?? [];
  const dimension = selectedDimension ?? preferred(panels)?.dimension ?? "wall_angle";
  if (!data && loading)
    return <QueryStatePanel variant="loading" contextLabel="Climbing strengths" />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <fieldset className="flex flex-wrap gap-2">
          <legend className="mb-2 text-xs text-muted">Break down by</legend>
          {Object.entries(dimensions)
            .filter(([item]) => item !== "setting")
            .map(([item, label]) => (
              <button
                key={item}
                type="button"
                aria-pressed={dimension === item}
                className={
                  "min-h-10 rounded-lg border px-3 text-sm " +
                  (dimension === item
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-border text-muted")
                }
                onClick={() => {
                  const next = panels.find((panel) => panel.dimension === item)?.dimension;
                  if (next) setDimension(next);
                  else if (item === "wall_angle" || item === "hold_type" || item === "setting")
                    setDimension(item);
                }}
              >
                {label}
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
        <ClimbingStrengthsBreakdown panels={panels} dimension={dimension} view={view} />
      ) : null}
    </div>
  );
}

function ClimbingStrengthsBreakdown({
  panels,
  dimension,
  view,
}: {
  panels: ClimbingStrengthsPanel[];
  dimension: ClimbingStrengthsPanel["dimension"];
  view: ClimbingStrengthsTab;
}) {
  const selectedPanels = panels.filter((panel) => panel.dimension === dimension);
  return (
    <section className="space-y-3">
      {selectedPanels.length ? (
        selectedPanels.map((panel) => (
          <section
            key={panel.key}
            aria-label={`${panel.contextLabel} · ${climbingProgressionSettingLabels[panel.setting ?? "unknown"]}`}
            className="min-w-0 space-y-3 border-t border-border pt-4"
          >
            <h3 className="font-semibold">
              {panel.contextLabel} · {climbingProgressionSettingLabels[panel.setting ?? "unknown"]}
            </h3>
            <ClimbingStrengthsPanelContent panel={panel} view={view} />
          </section>
        ))
      ) : (
        <QueryStatePanel
          variant="empty"
          message={`No recorded ${dimensions[dimension].toLowerCase()} observations for this context.`}
        />
      )}
    </section>
  );
}

function ClimbingStrengthsPanelContent({
  panel,
  view,
}: {
  panel: ClimbingStrengthsPanel;
  view: ClimbingStrengthsTab;
}) {
  const [selected, setSelected] = useState<{ row: string; grade: string } | null>(null);
  const displayPanel =
    view === "profile" ? panel : climbingStrengthsGradePanel(panel, ALL_CLIMBING_GRADES);
  const row = displayPanel.rows.find((item) => item.key === selected?.row);
  const cell = row?.cells.find((item) => item.grade === selected?.grade);
  return (
    <div className="space-y-3">
      {!observed(panel) ? (
        <QueryStatePanel
          variant="empty"
          message={`No recorded ${dimensions[panel.dimension].toLowerCase()} observations for this context.`}
        />
      ) : (
        <>
          <h4 className="font-medium">
            {view === "radar"
              ? "Strengths and weaknesses"
              : view === "profile"
                ? "Send rate by grade and style"
                : "Monthly send rate"}
          </h4>
          {view === "radar" ? (
            <p className="text-sm text-muted">
              Compared with your usual results at the same grades. Outside the dashed line is
              stronger; inside is weaker.
            </p>
          ) : view === "progress" ? (
            <p className="text-sm text-muted">
              Combines all grades; changes can reflect the difficulty of climbs recorded each month.
            </p>
          ) : null}
          {view === "profile" ? (
            <div className="space-y-4">
              {panel.grades.map((grade) => (
                <fieldset
                  key={grade.grade}
                  aria-label={`${grade.grade} send rates`}
                  className="min-w-0 space-y-2"
                >
                  <h5 className="text-sm font-semibold">{grade.grade}</h5>
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,7rem),1fr))] gap-2">
                    {panel.rows.map((item) => {
                      const value = item.cells.find((value) => value.grade === grade.grade);
                      return value ? (
                        <button
                          key={item.key}
                          type="button"
                          aria-label={`${item.label} · ${value.grade} · ${rateLabel(value)} · ${climbingStrengthsCountLabel(value)}${value.sampleStatus === "limited" ? " · Limited sample" : ""}`}
                          aria-pressed={row?.key === item.key && cell?.grade === value.grade}
                          onClick={() => setSelected({ row: item.key, grade: value.grade })}
                          className={`min-h-20 min-w-0 rounded-lg border p-2 text-center ${row?.key === item.key && cell?.grade === value.grade ? "ring-2 ring-accent" : ""} ${value.sampleStatus === "no_data" ? "border-dashed border-border text-dim" : "border-accent/20 text-foreground"}`}
                          style={
                            value.successRate === null
                              ? undefined
                              : {
                                  backgroundColor: `color-mix(in srgb, var(--color-accent) calc(${value.successRate}% * 0.4), var(--color-surface-solid))`,
                                }
                          }
                        >
                          <span className="block break-words text-xs">{item.label}</span>
                          <span className="block text-lg font-semibold">{rateLabel(value)}</span>
                          {value.sampleStatus === "limited" ? (
                            <span className="block text-xs">Limited sample</span>
                          ) : null}
                        </button>
                      ) : null;
                    })}
                  </div>
                </fieldset>
              ))}
            </div>
          ) : (
            <ClimbingStrengthsChart
              panel={displayPanel}
              view={view}
              grade={ALL_CLIMBING_GRADES}
              selectedRow={cell ? (row?.key ?? null) : null}
              onSelectCell={(row, grade) => setSelected({ row, grade })}
            />
          )}
        </>
      )}
      {cell && row ? (
        <section
          aria-label="Selected climbs"
          className="rounded-lg border border-border bg-surface p-4 space-y-3"
        >
          <h3 className="font-semibold">
            {row.label} · {cell.grade}
          </h3>
          {view === "progress" ? (
            <p className="text-xs text-muted">
              Across the selected period · counts and source climbs apply to the whole period.
            </p>
          ) : null}
          <p>
            {rateLabel(cell)} · {climbingStrengthsCountLabel(cell)}
          </p>
          {view === "radar" ? (
            <p className="text-xs text-muted">
              {climbingStrengthsDifferenceLabel(
                panel.gradeAdjustedStrengths.find((entry) => entry.key === row.key)
                  ?.differencePercentagePoints ?? null,
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
