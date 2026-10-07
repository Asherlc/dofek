import {
  type ClimbingGradeProgressionLane,
  climbingProgressionGradeColor,
  climbingProgressionLaneLabel,
  climbingProgressionPeriodLabel,
  climbingProgressionSettingLabels,
  climbingProgressionSettings,
  climbingProgressionValueLabel,
} from "@dofek/training/climbing-progression";
import { useState } from "react";
import {
  chartThemeColors,
  dofekAxis,
  dofekGrid,
  dofekSeries,
  dofekTooltip,
  escapeTooltipHtml,
} from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

interface ClimbingGradeProgressionChartProps {
  data: ClimbingGradeProgressionLane[];
  loading?: boolean;
}

function laneKey(lane: ClimbingGradeProgressionLane) {
  return `${lane.style}:${lane.gradeSystem}`;
}

function settingPattern(setting: ClimbingGradeProgressionLane["settings"][number]) {
  return setting === "indoor"
    ? undefined
    : {
        symbol: setting === "outdoor" ? "rect" : "circle",
        symbolSize: setting === "outdoor" ? 1 : 0.5,
        color: "rgba(15,23,42,0.45)",
        dashArrayX: setting === "outdoor" ? [1, 0] : [1, 4],
        dashArrayY: setting === "outdoor" ? [2, 4] : [1, 4],
        rotation: setting === "outdoor" ? -Math.PI / 4 : 0,
      };
}

function settingSwatch(setting: ClimbingGradeProgressionLane["settings"][number]) {
  return {
    backgroundColor: "#94a3b8",
    backgroundImage:
      setting === "outdoor"
        ? "repeating-linear-gradient(135deg, transparent, transparent 3px, #334155 3px, #334155 4px)"
        : setting === "unknown"
          ? "radial-gradient(#334155 1px, transparent 1px)"
          : undefined,
    backgroundSize: setting === "unknown" ? "4px 4px" : undefined,
  };
}

function laneOption(
  lane: ClimbingGradeProgressionLane,
  selectedSetting: string,
  styleLabel: string,
) {
  const settings = lane.settings.filter(
    (setting) => selectedSetting === "all" || setting === selectedSetting,
  );
  return {
    aria: {
      label: {
        description: `${styleLabel}: sends per climbing day`,
      },
    },
    grid: dofekGrid("single", { top: 10, bottom: 30, left: 32, right: 8, containLabel: true }),
    xAxis: dofekAxis.category({
      show: true,
      data: lane.periods.map((period) => climbingProgressionPeriodLabel(period)),
      axisLabel: { interval: 0, hideOverlap: true },
    }),
    yAxis: { ...dofekAxis.value({ min: 0, max: lane.axisMax }), interval: lane.axisInterval },
    tooltip: dofekTooltip({
      formatter: (params: Array<{ dataIndex: number }>) => {
        const period = lane.periods[params[0]?.dataIndex ?? -1];
        if (!period) return "";
        return [
          `<strong>${escapeTooltipHtml(climbingProgressionPeriodLabel(period, true))} · ${styleLabel}</strong>`,
          ...period.settings
            .filter((setting) => settings.includes(setting.setting))
            .flatMap((setting) => [
              `<br/><strong>${climbingProgressionSettingLabels[setting.setting]}</strong>`,
              escapeTooltipHtml(climbingProgressionValueLabel(setting)),
              ...setting.segments
                .filter((segment) => segment.sends > 0)
                .map(
                  (segment) =>
                    `${escapeTooltipHtml(segment.grade)}: ${escapeTooltipHtml(climbingProgressionValueLabel(setting, segment))}`,
                ),
            ]),
        ].join("<br/>");
      },
    }),
    series: settings.flatMap((setting) =>
      lane.grades.map(({ grade }, index) => ({
        ...dofekSeries.bar(
          `${styleLabel} · ${climbingProgressionSettingLabels[setting]} · ${grade}`,
          lane.periods.map((period) => {
            const point = period.settings.find((point) => point.setting === setting);
            const segment = point?.segments.find((segment) => segment.grade === grade);
            return {
              name: climbingProgressionPeriodLabel(period, true),
              value: segment?.sendsPerDay ?? null,
              displayValue:
                point && segment
                  ? climbingProgressionValueLabel(point, segment)
                  : "No recorded days",
            };
          }),
          {
            stack: setting,
            barWidth: settings.length === 1 ? "40%" : settings.length === 2 ? "22%" : "16%",
            barGap: "20%",
            color: climbingProgressionGradeColor(index, lane.grades.length),
            itemStyle: { decal: settingPattern(setting) },
          },
        ),
        markPoint:
          index === lane.grades.length - 1
            ? {
                silent: true,
                symbol: "circle",
                symbolSize: 1,
                itemStyle: { color: "transparent" },
                data: lane.periods.flatMap((period, periodIndex) => {
                  const point = period.settings.find((point) => point.setting === setting);
                  return point?.sendsPerDay == null || point.sendsPerDay === 0
                    ? [
                        {
                          coord: [periodIndex, 0],
                          label: {
                            show: true,
                            position: "top",
                            distance: 5,
                            color: chartThemeColors.axisLabel,
                            fontSize: 11,
                            formatter: point?.sendsPerDay === 0 ? "0" : "—",
                          },
                        },
                      ]
                    : [];
                }),
              }
            : undefined,
      })),
    ),
  };
}

export function ClimbingGradeProgressionChart({
  data,
  loading,
}: ClimbingGradeProgressionChartProps) {
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [selectedSetting, setSelectedSetting] = useState("all");
  const focused = data.find((lane) => laneKey(lane) === focusedKey);
  const visible = focused ? [focused] : data;
  const setting = focused?.settings.some((value) => value === selectedSetting)
    ? selectedSetting
    : "all";
  const availableSettings = climbingProgressionSettings.filter((setting) =>
    visible.some((lane) => lane.settings.includes(setting)),
  );

  if (data.length === 0)
    return (
      <DofekChart
        option={{ series: [] }}
        loading={loading}
        empty
        emptyMessage="No recorded climbing grades"
        height={180}
      />
    );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
        <span>Sends per climbing day</span>
        {focused ? (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="min-h-10 rounded border border-border px-3 text-foreground"
              onClick={() => {
                setFocusedKey(null);
                setSelectedSetting("all");
              }}
            >
              All styles
            </button>
            <label className="flex items-center gap-2">
              Setting
              <select
                value={setting}
                className="min-h-10 rounded border border-border bg-surface px-2 text-foreground"
                onChange={(event) => setSelectedSetting(event.target.value)}
              >
                <option value="all">All</option>
                {focused.settings.map((setting) => (
                  <option key={setting} value={setting}>
                    {climbingProgressionSettingLabels[setting]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            {availableSettings.map((setting) => (
              <span key={setting} className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-3 w-3 rounded-sm"
                  style={settingSwatch(setting)}
                  aria-hidden="true"
                />
                {climbingProgressionSettingLabels[setting]}
              </span>
            ))}
          </div>
        )}
      </div>
      {visible.map((lane) => (
        <section
          key={laneKey(lane)}
          aria-label={climbingProgressionLaneLabel(lane, data)}
          className="border-t border-border pt-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              {climbingProgressionLaneLabel(lane, data)}
            </h3>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              {lane.grades.map(({ grade }, index) => (
                <span key={grade} className="inline-flex items-center gap-1">
                  <span
                    aria-hidden="true"
                    className="inline-block h-2.5 w-2.5 rounded-sm"
                    style={{
                      backgroundColor: climbingProgressionGradeColor(index, lane.grades.length),
                    }}
                  />
                  {grade}
                </span>
              ))}
            </div>
            {!focused && (
              <button
                type="button"
                aria-label={`Focus ${climbingProgressionLaneLabel(lane, data)}`}
                className="min-h-10 rounded px-3 text-xs font-medium text-accent hover:bg-surface-hover"
                onClick={() => {
                  setFocusedKey(laneKey(lane));
                  setSelectedSetting("all");
                }}
              >
                Focus ↗
              </button>
            )}
          </div>
          <DofekChart
            option={laneOption(lane, setting, climbingProgressionLaneLabel(lane, data))}
            height={focused ? 300 : 170}
          />
        </section>
      ))}
    </div>
  );
}
