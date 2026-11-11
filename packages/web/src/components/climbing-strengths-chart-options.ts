import type {
  ClimbingStrengthsCell,
  ClimbingStrengthsDisplayPanel,
} from "@dofek/training/climbing-strengths";
import {
  ALL_CLIMBING_GRADES,
  climbingStrengthsAdjustedLabel,
  climbingStrengthsBaselineLabel,
  climbingStrengthsCountLabel,
  climbingStrengthsRateLabel,
  climbingStrengthsSendLabel,
} from "@dofek/training/climbing-strengths";
import type { ClimbingStrengthsView } from "@dofek/training/climbing-strengths-views";
import type { CustomSeriesRenderItem } from "echarts";
import {
  chartThemeColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
  escapeTooltipHtml,
  seriesColor,
} from "../lib/chartTheme.ts";

type Outcome = Pick<
  ClimbingStrengthsCell,
  "grade" | "sends" | "climbs" | "unknownOutcomes" | "successRate" | "sampleStatus"
>;
type OutcomeValues = Omit<Outcome, "sampleStatus"> & { sampleStatus?: Outcome["sampleStatus"] };
export function climbingStrengthsValueLabel(cell: OutcomeValues) {
  return `${climbingStrengthsRateLabel(cell)} · ${climbingStrengthsCountLabel(cell)}`;
}

function tooltipText(label: string, cell: OutcomeValues, period?: string) {
  return `${label} · ${cell.grade}${period ? ` · ${period}` : ""}\n${climbingStrengthsValueLabel(cell)}`;
}

function radarAxisFormatter(rows: ClimbingStrengthsDisplayPanel["rows"]) {
  const numbered = new Set(rows.map((row) => row.label)).size < rows.length;
  return (key: string) => {
    const index = rows.findIndex((row) => row.key === key);
    const row = rows[index];
    return row ? (numbered ? `${index + 1}. ${row.label}` : row.label) : key;
  };
}

export function climbingStrengthsChartOption(
  panel: ClimbingStrengthsDisplayPanel,
  view: ClimbingStrengthsView,
  grade: string,
  selectedRow: string | null,
) {
  const rowLabel = (key: string) => panel.rows.find((row) => row.key === key)?.label ?? key;
  const baseline = panel.grades.find((item) => item.grade === grade);
  const baselineLabel = climbingStrengthsBaselineLabel(grade);
  const selected = panel.rows.flatMap((row, index) => {
    const cell = row.cells.find((item) => item.grade === grade);
    return cell ? [{ row, cell, color: seriesColor(index) }] : [];
  });
  const point = (
    row: ClimbingStrengthsDisplayPanel["rows"][number],
    cell: Outcome,
    value: unknown,
    color: string,
    period?: string,
  ) => ({
    name: `${row.label} · ${cell.grade}`,
    value,
    rowKey: row.key,
    grade: cell.grade,
    displayValue: climbingStrengthsValueLabel(cell),
    tooltipText:
      tooltipText(row.label, cell, period) +
      ("differencePercentagePoints" in cell && cell.differencePercentagePoints !== null
        ? `\n${cell.differencePercentagePoints} percentage points vs ${climbingStrengthsBaselineLabel(cell.grade).toLowerCase()}`
        : ""),
    itemStyle: {
      color,
      borderColor: selectedRow === row.key ? chartThemeColors.tooltipText : color,
      borderWidth: selectedRow === row.key ? 3 : 0,
      opacity: cell.sampleStatus === "limited" ? 0.65 : 1,
    },
    symbol: cell.sampleStatus === "limited" ? "emptyCircle" : "circle",
  });
  const tooltip = dofekTooltip({
    trigger: "item",
    formatter: (params: { data?: unknown }) => {
      if (
        !params.data ||
        typeof params.data !== "object" ||
        !("tooltipText" in params.data) ||
        typeof params.data.tooltipText !== "string"
      )
        return "";
      return escapeTooltipHtml(params.data.tooltipText).replaceAll("\n", "<br/>");
    },
  });
  const chartGrade = view === "curves" || view === "pyramids" ? ALL_CLIMBING_GRADES : grade;
  const base = {
    grid: dofekGrid("single", { top: 50, bottom: 70, left: 24, right: 24, containLabel: true }),
    tooltip,
    legend: dofekLegend(true, { type: "scroll" }),
    aria: {
      label: {
        description: `${panel.contextLabel}. ${chartGrade}. ${view === "radar" && grade === ALL_CLIMBING_GRADES ? "Compared with your own climbs of the same difficulty. Outside the dashed line means you send more often than usual; inside means less often." : "Success per distinct climb; limited samples are marked."} Exact values are available below.`,
      },
    },
  };
  if (view === "gaps")
    return {
      ...base,
      xAxis: {
        ...dofekAxis.value({
          name: `Percentage points vs ${baselineLabel.toLowerCase()}`,
          min: -100,
          max: 100,
        }),
        nameLocation: "middle",
        nameGap: 32,
      },
      yAxis: {
        ...dofekAxis.category({
          show: true,
          data: selected.map(({ row }) => row.label),
          axisLabel: { width: 150, overflow: "truncate", interval: 0 },
        }),
        inverse: true,
      },
      series: [
        dofekSeries.bar(
          "Success gap",
          selected.map(({ row, cell, color }) =>
            point(row, cell, cell.differencePercentagePoints, color),
          ),
          { barWidth: 22 },
        ),
      ],
    };
  if (view === "curves")
    return {
      ...base,
      legend: { ...base.legend, formatter: radarAxisFormatter(panel.rows) },
      xAxis: dofekAxis.category({ show: true, data: panel.grades.map((item) => item.grade) }),
      yAxis: dofekAxis.value({ name: "Success (%)", min: 0, max: 100 }),
      series: [
        ...panel.rows.map((row, index) =>
          dofekSeries.line(
            row.key,
            row.cells.map((cell) => point(row, cell, cell.successRate, seriesColor(index))),
            { color: seriesColor(index), smooth: false, symbol: "circle", symbolSize: 8 },
          ),
        ),
        dofekSeries.line(
          "Same-grade baseline",
          panel.grades.map((item) => ({
            name: `Same-grade baseline · ${item.grade}`,
            value: item.successRate,
            displayValue: climbingStrengthsValueLabel(item),
            tooltipText: tooltipText("Same-grade baseline", item),
          })),
          {
            color: chartThemeColors.axisLabel,
            smooth: false,
            symbol: "diamond",
            symbolSize: 6,
            lineStyle: { type: "dashed" },
          },
        ),
      ],
    };
  if (view === "exposure")
    return {
      ...base,
      xAxis: {
        ...dofekAxis.value({ name: "Distinct climbs", min: 0 }),
        nameLocation: "middle",
        nameGap: 32,
      },
      yAxis: dofekAxis.value({ name: "Gap (percentage points)", min: -100, max: 100 }),
      series: [
        {
          ...dofekSeries.scatter(
            "Style exposure",
            selected
              .filter(({ cell }) => cell.differencePercentagePoints !== null)
              .map(({ row, cell, color }) => ({
                ...point(row, cell, [cell.climbs, cell.differencePercentagePoints], color),
                label: {
                  show: true,
                  formatter: row.label,
                  position: "top",
                  color: chartThemeColors.axisLabel,
                },
              })),
            { symbolSize: 18 },
          ),
          markLine: {
            silent: true,
            symbol: "none",
            data: [{ yAxis: 0 }],
            lineStyle: { color: chartThemeColors.axisLabel, type: "dashed" },
          },
        },
      ],
    };
  if (view === "pyramids") {
    const grades = [...panel.grades].reverse();
    const facetHeight = panel.grades.length * 28 + 100;
    const axisMax = Math.max(
      1,
      ...panel.rows.flatMap((row) => row.cells.map((cell) => cell.climbs)),
    );
    return {
      ...base,
      title: panel.rows.map((row, index) => ({
        text: row.label,
        top: 30 + index * facetHeight,
        left: 24,
        textStyle: {
          color: chartThemeColors.tooltipText,
          fontSize: 13,
          width: 250,
          overflow: "truncate",
        },
      })),
      grid: panel.rows.map((_, index) => ({
        ...dofekGrid("single", {
          top: 60 + index * facetHeight,
          left: 24,
          right: 24,
          containLabel: true,
        }),
        height: panel.grades.length * 28,
        bottom: undefined,
      })),
      xAxis: panel.rows.map((_, index) => ({
        ...dofekAxis.value({ name: "Distinct climbs", min: 0, max: axisMax }),
        gridIndex: index,
        nameLocation: "middle",
        nameGap: 30,
      })),
      yAxis: panel.rows.map((_, index) => ({
        ...dofekAxis.category({
          show: true,
          data: grades.map((item) => item.grade),
          axisLabel: { interval: 0 },
        }),
        gridIndex: index,
        inverse: true,
      })),
      series: panel.rows.flatMap((row, index) => {
        const cells = grades.flatMap((grade) => {
          const cell = row.cells.find((cell) => cell.grade === grade.grade);
          return cell ? [cell] : [];
        });
        const centeredSeries = (name: string, metric: "climbs" | "sends", color: string) => {
          const data = cells.map((cell) =>
            point(row, cell, cell.sampleStatus === "no_data" ? null : cell[metric], color),
          );
          const renderItem: CustomSeriesRenderItem = (params, api) => {
            const item = data[params.dataIndex];
            const count = api.value(0);
            if (!item || typeof count !== "number" || !Number.isFinite(count)) return;
            const [centerX = 0, centerY = 0] = api.coord([axisMax / 2, params.dataIndex]);
            const [startX = 0] = api.coord([0, params.dataIndex]);
            const [endX = 0] = api.coord([count, params.dataIndex]);
            const width = Math.abs(endX - startX);
            return {
              type: "rect",
              shape: { x: centerX - width / 2, y: centerY - 9, width, height: 18 },
              style: {
                fill: item.itemStyle.color,
                stroke: item.itemStyle.borderColor,
                lineWidth: item.itemStyle.borderWidth,
                opacity: item.itemStyle.opacity,
              },
            };
          };
          return {
            name,
            type: "custom" as const,
            data,
            renderItem,
            encode: { x: 0 },
            xAxisIndex: index,
            yAxisIndex: index,
            z: metric === "sends" ? 2 : 1,
          };
        };
        return [
          centeredSeries("Total climbs", "climbs", chartThemeColors.axisLine),
          centeredSeries("Sends", "sends", seriesColor(index)),
        ];
      }),
    };
  }
  if (view === "progress")
    return {
      ...base,
      legend: {
        ...dofekLegend(true, { type: "scroll" }),
        formatter: (name: string) =>
          `${panel.rows.findIndex((row) => row.key === name) + 1}. ${rowLabel(name)}`,
      },
      xAxis: dofekAxis.category({
        show: true,
        data: panel.progress.map((period) => period.startDate.slice(0, 7)),
        axisLabel: { hideOverlap: true },
      }),
      yAxis: dofekAxis.value({
        name: "Send rate (%)",
        min: 0,
        max: 100,
        axisLabel: { formatter: "{value}%" },
      }),
      series: panel.rows.map((row, index) => ({
        ...dofekSeries.line(
          row.key,
          panel.progress.map((period) => {
            const cell = period.rows
              .find((item) => item.key === row.key)
              ?.cells.find((item) => item.grade === grade);
            return cell
              ? point(
                  row,
                  cell,
                  cell.successRate,
                  seriesColor(index),
                  `${period.startDate} – ${period.endDate}`,
                )
              : null;
          }),
          {
            color: seriesColor(index),
            smooth: false,
            symbol: "circle",
            symbolSize: 9,
          },
        ),
        label: { show: true, position: "top", formatter: String(index + 1) },
      })),
    };
  if (view === "radar" && grade === ALL_CLIMBING_GRADES) {
    const axes = selected.flatMap(({ row, cell }) => {
      const strength = panel.gradeAdjustedStrengths.find((entry) => entry.key === row.key);
      return strength && strength.differencePercentagePoints !== null
        ? [{ row, cell, strength, value: strength.differencePercentagePoints }]
        : [];
    });
    return {
      ...base,
      radar: {
        triggerEvent: true,
        indicator: axes.map(({ row }) => ({ name: row.key, min: -100, max: 100 })),
        radius: "62%",
        axisName: {
          formatter: radarAxisFormatter(axes.map(({ row }) => row)),
          color: chartThemeColors.axisLabel,
          width: 110,
          overflow: "break",
        },
        splitLine: { lineStyle: { color: chartThemeColors.gridLine } },
      },
      series: [
        {
          type: "radar",
          data: [
            {
              name: "Climbing strengths",
              value: axes.map((axis) => axis.value),
              tooltipText: axes
                .map(
                  ({ row, cell, strength }) => `${row.label} · ${climbingStrengthsSendLabel(cell)}
${climbingStrengthsAdjustedLabel(strength)}`,
                )
                .join("\n"),
              lineStyle: { color: seriesColor(0) },
              itemStyle: { color: seriesColor(0) },
              areaStyle: { opacity: 0.12 },
            },
            {
              name: "Your usual send rate",
              value: axes.map(() => 0),
              tooltipText: "Your usual send rate for climbs of the same difficulty",
              lineStyle: { type: "dashed", color: chartThemeColors.axisLabel },
              itemStyle: { color: chartThemeColors.axisLabel },
            },
          ],
        },
      ],
    };
  }
  const axes = selected.filter(({ cell }) => cell.successRate !== null);
  return {
    ...base,
    radar: {
      triggerEvent: true,
      indicator: axes.map(({ row }) => ({ name: row.key, min: 0, max: 100 })),
      radius: "62%",
      axisName: {
        formatter: radarAxisFormatter(axes.map(({ row }) => row)),
        color: chartThemeColors.axisLabel,
        width: 110,
        overflow: "break",
      },
      splitLine: { lineStyle: { color: chartThemeColors.gridLine } },
    },
    series: [
      {
        type: "radar",
        data: [
          {
            name: "Observed success",
            value: axes.map(({ cell }) => cell.successRate),
            tooltipText: axes.map(({ row, cell }) => tooltipText(row.label, cell)).join("\n"),
            lineStyle: { color: seriesColor(0) },
            itemStyle: { color: seriesColor(0) },
            areaStyle: { opacity: 0.12 },
          },
          {
            name: baselineLabel,
            value: axes.map(() => baseline?.successRate ?? null),
            tooltipText: baseline
              ? tooltipText(baselineLabel, baseline)
              : `${baselineLabel} · ${grade}\nNo data`,
            lineStyle: { type: "dashed", color: chartThemeColors.axisLabel },
            itemStyle: { color: chartThemeColors.axisLabel },
          },
        ],
      },
    ],
  };
}
