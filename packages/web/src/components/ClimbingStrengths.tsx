import type {
  ClimbingStrengthsCell,
  ClimbingStrengthsPanel,
  ClimbingStrengths as Strengths,
} from "@dofek/training/climbing-strengths";
import { useState } from "react";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

const dimensions = {
  wall_angle: "Wall angle",
  hold_type: "Hold type",
  setting: "Indoor & outdoor",
};
const settings = { indoor: "Indoor", outdoor: "Outdoor" };
function observed(panel: ClimbingStrengthsPanel) {
  return panel.rows.some((row) => row.cells.some((cell) => cell.sampleStatus !== "no_data"));
}
function preferred(panels: ClimbingStrengthsPanel[]) {
  return (
    panels.find((panel) => panel.dimension === "wall_angle" && observed(panel)) ??
    panels.find((panel) => panel.dimension === "setting" && observed(panel)) ??
    panels.find(observed) ??
    panels[0]
  );
}
function rateLabel(cell: ClimbingStrengthsCell) {
  return cell.successRate === null ? "No data" : `${cell.successRate}%`;
}

export function ClimbingStrengths({
  data,
  loading,
}: {
  data: Strengths | undefined;
  loading?: boolean;
}) {
  const [panelKey, setPanelKey] = useState<string | null>(null);
  const [lastSetting, setLastSetting] = useState<{
    contextKey: string;
    setting: "indoor" | "outdoor";
  } | null>(null);
  const [selected, setSelected] = useState<{ panel: string; row: string; grade: string } | null>(
    null,
  );
  const panels = data?.panels ?? [];
  const panel = panels.find((item) => item.key === panelKey) ?? preferred(panels);
  const contexts = [
    ...new Map(panels.map((item) => [item.contextKey, item.contextLabel])).entries(),
  ];
  const contextPanels = panels.filter((item) => item.contextKey === panel?.contextKey);
  const settingPanels = contextPanels.filter((item) => item.dimension === panel?.dimension);
  const row =
    panel && selected && panel.key === selected.panel
      ? panel.rows.find((item) => item.key === selected.row)
      : undefined;
  const cell = row?.cells.find((item) => item.grade === selected?.grade);

  if (!data && loading)
    return <QueryStatePanel variant="loading" contextLabel="Climbing strengths" />;
  if (!panel)
    return (
      <div className="space-y-3">
        <QueryStatePanel variant="empty" message="No recorded climbing strengths in this period." />
        {data ? <Coverage data={data} /> : null}
      </div>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {Object.entries(dimensions).map(([dimension, label]) => (
            <button
              key={dimension}
              type="button"
              aria-pressed={panel.dimension === dimension}
              className={`min-h-10 rounded-lg border px-3 text-sm ${panel.dimension === dimension ? "border-accent bg-accent/10 text-accent" : "border-border text-muted"}`}
              onClick={() => {
                const setting =
                  panel.setting ??
                  (lastSetting?.contextKey === panel.contextKey ? lastSetting.setting : null);
                if (panel.setting)
                  setLastSetting({ contextKey: panel.contextKey, setting: panel.setting });
                const candidates = contextPanels.filter((item) => item.dimension === dimension);
                const next =
                  candidates.find((item) => item.setting === setting) ?? preferred(candidates);
                if (next) setPanelKey(next.key);
              }}
              disabled={!contextPanels.some((item) => item.dimension === dimension)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-3">
          {contexts.length > 1 ? (
            <label className="text-xs text-muted">
              Climbing context
              <select
                className="ml-2 rounded border border-border bg-surface p-2"
                value={panel.contextKey}
                onChange={(event) => {
                  const next = preferred(
                    panels.filter((item) => item.contextKey === event.target.value),
                  );
                  if (next) setPanelKey(next.key);
                }}
              >
                {contexts.map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {panel.dimension !== "setting" && settingPanels.length > 1 ? (
            <label className="text-xs text-muted">
              Strength setting
              <select
                className="ml-2 rounded border border-border bg-surface p-2"
                value={panel.key}
                onChange={(event) => setPanelKey(event.target.value)}
              >
                {settingPanels.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.setting ? settings[item.setting] : "Unknown"}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </div>
      <p className="text-sm text-muted">{panel.contextLabel}</p>
      <p className="text-xs text-muted">
        {panel.setting ? `${settings[panel.setting]} · ` : "Indoor & outdoor · "}Sends per distinct
        climb. Select a cell to see its climbs.
      </p>
      {observed(panel) ? (
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
                        aria-label={`${item.label} · ${value.grade} · ${rateLabel(value)} · ${value.sends} sends / ${value.climbs} climbs${value.sampleStatus === "limited" ? " · Limited data" : ""}`}
                        aria-pressed={row?.key === item.key && cell?.grade === value.grade}
                        onClick={() =>
                          setSelected({ panel: panel.key, row: item.key, grade: value.grade })
                        }
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
                            : `${value.sends} / ${value.climbs} climbs`}
                        </span>
                        {value.sampleStatus === "limited" ? (
                          <span className="block text-xs text-muted">Limited data</span>
                        ) : null}
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <QueryStatePanel
          variant="empty"
          message={`No recorded ${dimensions[panel.dimension].toLowerCase()} observations for this context.`}
        />
      )}
      {cell && row ? (
        <section
          aria-label="Selected climbs"
          className="rounded-lg border border-border bg-surface p-4 space-y-3"
        >
          <h3 className="font-semibold">
            {row.label} · {cell.grade}
          </h3>
          <p>
            {rateLabel(cell)} · {cell.sends} sends / {cell.climbs} climbs
          </p>
          {cell.sampleStatus === "limited" ? (
            <p className="text-xs text-muted">Limited data</p>
          ) : null}
          {cell.differencePercentagePoints !== null ? (
            <p className="text-xs text-muted">
              {cell.differencePercentagePoints > 0 ? "+" : ""}
              {cell.differencePercentagePoints} percentage points vs same-grade baseline
            </p>
          ) : null}
          {cell.examples.map((example) => (
            <div key={example.logEntryId} className="border-t border-border pt-3 text-sm">
              <p className="font-medium">{example.name}</p>
              <p className="text-xs text-muted">
                {example.grade} · {example.date} ·{" "}
                {example.outcome === "sent" ? "Sent" : "Not sent"}
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
      <Coverage data={data} panel={panel} />
    </div>
  );
}

function Coverage({
  data,
  panel,
}: {
  data: Strengths | undefined;
  panel?: ClimbingStrengthsPanel;
}) {
  if (!data) return null;
  return (
    <details className="text-xs text-muted">
      <summary className="cursor-pointer py-2">Coverage</summary>
      <p>
        {data.coverage.unknownOutcomes} unknown outcomes · {data.coverage.missingGrades} records
        excluded for missing or conflicting grades · {data.coverage.missingIdentity} unidentified
        records excluded
      </p>
      {panel ? (
        <p>
          {panel.coverage.missingTraits} climbs missing {dimensions[panel.dimension].toLowerCase()}{" "}
          · {panel.coverage.unknownOutcomes} unknown outcomes in this context
        </p>
      ) : null}
    </details>
  );
}
