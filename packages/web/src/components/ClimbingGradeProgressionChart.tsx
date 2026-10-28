import {
  type ClimbingGradeProgressionData,
  climbingProgressionGradeColor,
  climbingProgressionGradeLabel,
  climbingProgressionPeriodLabel,
  climbingProgressionValueLabel,
} from "@dofek/training/climbing-progression";
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
  data: ClimbingGradeProgressionData | null;
  loading?: boolean;
}

function chartOption(data: ClimbingGradeProgressionData) {
  return {
    aria: { label: { description: "Grade progression: sends per climbing day" } },
    grid: dofekGrid("single", { top: 10, bottom: 30, left: 32, right: 8, containLabel: true }),
    xAxis: dofekAxis.category({
      show: true,
      data: data.periods.map((period) => climbingProgressionPeriodLabel(period)),
      axisLabel: { interval: 0, hideOverlap: true },
    }),
    yAxis: { ...dofekAxis.value({ min: 0, max: data.axisMax }), interval: data.axisInterval },
    tooltip: dofekTooltip({
      formatter: (params: Array<{ dataIndex: number }>) => {
        const period = data.periods[params[0]?.dataIndex ?? -1];
        if (!period) return "";
        return [
          "<strong>" +
            escapeTooltipHtml(climbingProgressionPeriodLabel(period, true)) +
            "</strong>",
          escapeTooltipHtml(climbingProgressionValueLabel(period)),
          ...data.grades.flatMap((grade) => {
            const segment = period.segments.find((segment) => segment.gradeKey === grade.key);
            return segment && segment.sends > 0
              ? [
                  escapeTooltipHtml(climbingProgressionGradeLabel(grade, data.grades)) +
                    ": " +
                    escapeTooltipHtml(climbingProgressionValueLabel(period, segment)),
                ]
              : [];
          }),
        ].join("<br/>");
      },
    }),
    series: data.grades.map((grade, index) => ({
      ...dofekSeries.bar(
        climbingProgressionGradeLabel(grade, data.grades),
        data.periods.map((period) => {
          const segment = period.segments.find((segment) => segment.gradeKey === grade.key);
          return {
            name: climbingProgressionPeriodLabel(period, true),
            value: segment?.sendsPerDay ?? null,
            displayValue: segment
              ? climbingProgressionValueLabel(period, segment)
              : "No recorded days",
          };
        }),
        {
          stack: "sends",
          barWidth: "40%",
          color: climbingProgressionGradeColor(index, data.grades.length),
        },
      ),
      markPoint:
        index === data.grades.length - 1
          ? {
              silent: true,
              symbol: "circle",
              symbolSize: 1,
              itemStyle: { color: "transparent" },
              data: data.periods.flatMap((period, periodIndex) =>
                period.sendsPerDay === null || period.sendsPerDay === 0
                  ? [
                      {
                        coord: [periodIndex, 0],
                        label: {
                          show: true,
                          position: "top",
                          distance: 5,
                          color: chartThemeColors.axisLabel,
                          fontSize: 11,
                          formatter: period.sendsPerDay === 0 ? "0" : "—",
                        },
                      },
                    ]
                  : [],
              ),
            }
          : undefined,
    })),
  };
}

export function ClimbingGradeProgressionChart({
  data,
  loading,
}: ClimbingGradeProgressionChartProps) {
  if (!data)
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
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {data.grades.map((grade, index) => (
            <span key={grade.key} className="inline-flex items-center gap-1">
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{
                  backgroundColor: climbingProgressionGradeColor(index, data.grades.length),
                }}
              />
              {climbingProgressionGradeLabel(grade, data.grades)}
            </span>
          ))}
        </div>
      </div>
      <DofekChart option={chartOption(data)} height={260} />
    </div>
  );
}
