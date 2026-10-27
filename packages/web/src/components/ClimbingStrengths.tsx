import type {
  ClimbingStrengthsCell,
  ClimbingStrengthsPanel,
  ClimbingStrengths as Strengths,
} from "@dofek/training/climbing-strengths";
import {
  ALL_CLIMBING_GRADES,
  climbingStrengthsCountLabel,
  climbingStrengthsGradePanel,
  climbingStrengthsRateLabel,
  climbingStrengthsResultLabel,
} from "@dofek/training/climbing-strengths";
import {
  CLIMBING_STRENGTHS_PURPOSES,
  CLIMBING_STRENGTHS_VIEWS,
  type ClimbingStrengthsView,
  climbingStrengthsPurpose,
  climbingStrengthsPurposeView,
} from "@dofek/training/climbing-strengths-views";
import { useState } from "react";
import { ClimbingStrengthsChart } from "./ClimbingStrengthsChart.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

const dimensions = {
  wall_angle: "Wall angle",
  hold_type: "Hold type",
  setting: "Indoor & outdoor",
};
const settings = { indoor: "Indoor", outdoor: "Outdoor", unknown: "Setting unknown" };
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
  const [selectedDimension, setDimension] = useState<ClimbingStrengthsPanel["dimension"] | null>(
    null,
  );
  const [view, setView] = useState<ClimbingStrengthsView>("gaps");
  const panels = data?.panels ?? [];
  const dimension = selectedDimension ?? preferred(panels)?.dimension ?? "wall_angle";
  const contexts = [
    ...new Map(panels.map((panel) => [panel.contextKey, panel.contextLabel])).entries(),
  ];
  if (!data && loading)
    return <QueryStatePanel variant="loading" contextLabel="Climbing strengths" />;
  return (
    <div className="space-y-4">
      <fieldset aria-label="Strengths view" className="flex flex-wrap gap-5 border-b border-border">
        {CLIMBING_STRENGTHS_PURPOSES.map((purpose) => (
          <button
            key={purpose.value}
            type="button"
            aria-pressed={climbingStrengthsPurpose(view) === purpose.value}
            onClick={() => {
              if (climbingStrengthsPurpose(view) !== purpose.value)
                setView(climbingStrengthsPurposeView(purpose.value));
            }}
            className={`min-h-11 border-b-2 pb-2 text-sm font-medium ${climbingStrengthsPurpose(view) === purpose.value ? "border-accent text-accent" : "border-transparent text-muted"}`}
          >
            {purpose.label}
          </button>
        ))}
      </fieldset>
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
        <details className="text-xs text-muted">
          <summary className="min-h-11 cursor-pointer py-3 text-foreground">Chart options</summary>
          <div className="space-y-3 py-2">
            <label className="block text-xs text-muted">
              View
              <select
                className="ml-2 min-h-10 rounded border border-border bg-surface p-2"
                value={view}
                onChange={(event) => {
                  const next = CLIMBING_STRENGTHS_VIEWS.find(
                    (item) => item.value === event.target.value,
                  );
                  if (next) setView(next.value);
                }}
              >
                {CLIMBING_STRENGTHS_VIEWS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                checked={dimension === "setting"}
                onChange={(event) => setDimension(event.target.checked ? "setting" : null)}
              />
              Compare indoor/outdoor
            </label>
          </div>
        </details>
      </div>
      {!panels.length ? (
        <QueryStatePanel variant="empty" message="No recorded climbing strengths in this period." />
      ) : null}
      {panels.some((panel) => panel.grades.some((grade) => grade.unknownOutcomes > 0)) ? (
        <p className="text-xs text-muted">Success rates use climbs with known results.</p>
      ) : null}
      {contexts.map(([key, label]) => (
        <ClimbingStrengthsContext
          key={key}
          panels={panels.filter((panel) => panel.contextKey === key)}
          dimension={dimension}
          view={view}
          label={contexts.length > 1 ? label : undefined}
        />
      ))}
    </div>
  );
}

function ClimbingStrengthsContext({
  panels,
  dimension,
  view,
  label,
}: {
  panels: ClimbingStrengthsPanel[];
  dimension: ClimbingStrengthsPanel["dimension"];
  view: ClimbingStrengthsView;
  label: string | undefined;
}) {
  const [gradeKey, setGradeKey] = useState<string | null>(null);
  const selectedPanels = panels.filter((panel) => panel.dimension === dimension);
  const grades = [
    ...new Map(
      selectedPanels.flatMap((panel) => panel.grades.map((grade) => [grade.grade, grade] as const)),
    ).values(),
  ].sort((first, second) => first.gradeSortValue - second.gradeSortValue);
  const grade =
    gradeKey === ALL_CLIMBING_GRADES
      ? ALL_CLIMBING_GRADES
      : (grades.find((item) => item.grade === gradeKey)?.grade ??
        grades[0]?.grade ??
        ALL_CLIMBING_GRADES);
  return (
    <section className="space-y-3" aria-label={label}>
      {label ? <h3 className="font-semibold">{label}</h3> : null}
      {view !== "profile" && view !== "curves" && view !== "pyramids" && grades.length > 0 ? (
        <label className="text-xs text-muted">
          Grade
          <select
            className="ml-2 min-h-10 rounded border border-border bg-surface p-2"
            value={grade}
            onChange={(event) => setGradeKey(event.target.value)}
          >
            <option value={ALL_CLIMBING_GRADES}>{ALL_CLIMBING_GRADES}</option>
            {grades.map((item) => (
              <option key={item.grade} value={item.grade}>
                {item.grade}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {grade === ALL_CLIMBING_GRADES &&
      view !== "profile" &&
      view !== "curves" &&
      view !== "pyramids" &&
      grades.length > 0 ? (
        <p className="text-xs text-muted">
          All grades combines different difficulties; comparisons are not grade-adjusted.
        </p>
      ) : null}
      {selectedPanels.length ? (
        selectedPanels.map((panel) => (
          <div key={panel.key} className="space-y-3">
            {dimension !== "setting" && panel.setting ? (
              <h4 className="text-sm font-medium">{settings[panel.setting]}</h4>
            ) : null}
            <ClimbingStrengthsPanelContent
              panel={panel}
              view={view}
              grade={grade}
              onGradeChange={setGradeKey}
            />
          </div>
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
  grade,
  onGradeChange,
}: {
  panel: ClimbingStrengthsPanel;
  view: ClimbingStrengthsView;
  grade: string;
  onGradeChange: (grade: string) => void;
}) {
  const [selected, setSelected] = useState<{ row: string; grade: string } | null>(null);
  const row =
    selected &&
    (selected.grade === ALL_CLIMBING_GRADES ||
      panel.grades.some((item) => item.grade === selected.grade))
      ? (grade === ALL_CLIMBING_GRADES ? panel.allGrades.rows : panel.rows).find(
          (item) => item.key === selected.row,
        )
      : undefined;
  const cell = row?.cells.find((item) => item.grade === grade);
  const gradePanel = climbingStrengthsGradePanel(panel, grade);
  const selectCell = (rowKey: string, selectedGrade: string) => {
    onGradeChange(selectedGrade);
    setSelected({ row: rowKey, grade: selectedGrade });
  };
  return (
    <div className="space-y-3">
      {!observed(panel) ? (
        <QueryStatePanel
          variant="empty"
          message={
            "No recorded " +
            dimensions[panel.dimension].toLowerCase() +
            " observations for this context."
          }
        />
      ) : view !== "profile" ? (
        <ClimbingStrengthsChart
          panel={view === "curves" || view === "pyramids" ? panel : (gradePanel ?? panel)}
          view={view}
          grade={grade}
          selectedRow={row?.key ?? null}
          onSelectCell={selectCell}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-1 text-sm">
            <caption className="sr-only">
              Success by grade and {dimensions[panel.dimension].toLowerCase()}
            </caption>
            <thead>
              <tr>
                <th scope="col" className="text-left text-muted">
                  Style
                </th>
                {panel.grades.map((grade) => (
                  <th key={grade.grade} scope="col" className="p-2 text-muted">
                    {grade.grade}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {panel.rows.map((item) => (
                <tr key={item.key}>
                  <th scope="row" className="pr-3 text-left font-medium">
                    {item.label}
                  </th>
                  {item.cells.map((value) => (
                    <td key={value.grade}>
                      <button
                        type="button"
                        aria-label={`${item.label} · ${value.grade} · ${rateLabel(value)} · ${climbingStrengthsCountLabel(value)}`}
                        aria-pressed={row?.key === item.key && cell?.grade === value.grade}
                        onClick={() => selectCell(item.key, value.grade)}
                        className={`min-h-20 w-full min-w-24 rounded-lg border p-2 text-center focus-visible:outline-2 focus-visible:outline-accent ${row?.key === item.key && cell?.grade === value.grade ? "ring-2 ring-accent ring-offset-2 ring-offset-surface-solid" : ""} ${value.sampleStatus === "no_data" ? "border-dashed border-border text-dim" : "border-accent/20 text-foreground"}`}
                        style={
                          value.successRate === null
                            ? undefined
                            : {
                                backgroundColor: `color-mix(in srgb, var(--color-accent) calc(${value.successRate}% * 0.35), var(--color-surface-solid))`,
                                backgroundImage:
                                  value.sampleStatus === "limited"
                                    ? "repeating-linear-gradient(135deg, transparent, transparent 5px, var(--color-border) 5px, var(--color-border) 6px)"
                                    : undefined,
                              }
                        }
                      >
                        <span className="block text-lg font-semibold">{rateLabel(value)}</span>
                        <span className="block text-xs">
                          {value.sampleStatus === "no_data"
                            ? "No recorded climbs"
                            : climbingStrengthsCountLabel(value)}
                        </span>
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
              Across the selected period · counts and source climbs below apply to the whole period.
            </p>
          ) : null}
          <p>
            {rateLabel(cell)} · {climbingStrengthsCountLabel(cell)}
          </p>
          {cell.differencePercentagePoints !== null ? (
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
