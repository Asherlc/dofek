import type {
  ClimbingStrengthsCell,
  ClimbingStrengthsPanel,
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
  "grade" | "sends" | "climbs" | "successRate" | "sampleStatus"
>;
type OutcomeValues = Omit<Outcome, "sampleStatus"> & { sampleStatus?: Outcome["sampleStatus"] };
export function climbingStrengthsValueLabel(cell: OutcomeValues) {
  return `${cell.successRate === null ? "No data" : `${cell.successRate}%`} · ${cell.sends} sends / ${cell.climbs} climbs${cell.sampleStatus === "limited" ? " · Limited data" : ""}`;
}

function tooltipText(label: string, cell: OutcomeValues, period?: string) {
  return `${label} · ${cell.grade}${period ? ` · ${period}` : ""}\n${climbingStrengthsValueLabel(cell)}`;
}

export function climbingStrengthsChartOption(
  panel: ClimbingStrengthsPanel,
  view: Exclude<ClimbingStrengthsView, "profile">,
  grade: string,
  selectedRow: string | null,
) {
  const baseline = panel.grades.find((item) => item.grade === grade);
  const selected = panel.rows.flatMap((row, index) => {
    const cell = row.cells.find((item) => item.grade === grade);
    return cell ? [{ row, cell, color: seriesColor(index) }] : [];
  });
  const point = (
    row: ClimbingStrengthsPanel["rows"][number],
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
        ? `\n${cell.differencePercentagePoints} percentage points vs same-grade baseline`
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
  const base = {
    grid: dofekGrid("single", { top: 50, bottom: 70, left: 24, right: 24, containLabel: true }),
    tooltip,
    legend: dofekLegend(true, { type: "scroll" }),
    aria: {
      label: {
        description: `${panel.contextLabel}. ${grade}. Success per distinct climb; limited samples are marked. Exact values are available below.`,
      },
    },
  };
  if (view === "gaps")
    return {
      ...base,
      xAxis: {
        ...dofekAxis.value({
          name: "Percentage points vs same-grade baseline",
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
      xAxis: dofekAxis.category({ show: true, data: panel.grades.map((item) => item.grade) }),
      yAxis: dofekAxis.value({ name: "Success (%)", min: 0, max: 100 }),
      series: [
        ...panel.rows.map((row, index) =>
          dofekSeries.line(
            row.label,
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
      legend: dofekLegend(false),
      title: panel.rows.map((row, index) => ({
        text: row.label,
        top: 20 + index * 190,
        left: 24,
        textStyle: { color: seriesColor(index), fontSize: 13, width: 250, overflow: "truncate" },
      })),
      grid: panel.rows.map((_, index) => ({
        ...dofekGrid("single", { top: 50 + index * 190, left: 24, right: 24, containLabel: true }),
        height: 110,
        bottom: undefined,
      })),
      xAxis: panel.rows.map((_, index) => ({
        ...dofekAxis.category({
          show: true,
          data: panel.progress.map((period) => `${period.startDate} – ${period.endDate}`),
          axisLabel: { hideOverlap: true },
        }),
        gridIndex: index,
      })),
      yAxis: panel.rows.map((_, index) => ({
        ...dofekAxis.value({ name: "Success (%)", min: 0, max: 100 }),
        gridIndex: index,
        interval: 50,
      })),
      series: panel.rows.map((row, index) => ({
        ...dofekSeries.line(
          row.label,
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
          { color: seriesColor(index), smooth: false, symbol: "circle", symbolSize: 9 },
        ),
        xAxisIndex: index,
        yAxisIndex: index,
      })),
    };
  const axes = selected.filter(({ cell }) => cell.successRate !== null);
  return {
    ...base,
    radar: {
      indicator: axes.map(({ row }) => ({ name: row.label, min: 0, max: 100 })),
      radius: "62%",
      axisName: { color: chartThemeColors.axisLabel, width: 110, overflow: "break" },
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
            name: "Same-grade baseline",
            value: axes.map(() => baseline?.successRate ?? null),
            tooltipText: baseline
              ? tooltipText("Same-grade baseline", baseline)
              : `Same-grade baseline · ${grade}\nNo data`,
            lineStyle: { type: "dashed", color: chartThemeColors.axisLabel },
            itemStyle: { color: chartThemeColors.axisLabel },
          },
        ],
      },
    ],
  };
}
