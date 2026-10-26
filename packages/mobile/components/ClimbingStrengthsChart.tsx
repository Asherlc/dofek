import type { ClimbingStrengthsPanel } from "@dofek/training/climbing-strengths";
import { climbingStrengthsBaselineLabel } from "@dofek/training/climbing-strengths";
import {
  CLIMBING_STRENGTHS_VIEWS,
  type ClimbingStrengthsView,
} from "@dofek/training/climbing-strengths-views";
import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, G, Line, Polygon, Rect, Text as SvgText } from "react-native-svg";
import { colors } from "../theme";
import { AccessibleChart } from "./AccessibleChart";

type ViewKind = Exclude<ClimbingStrengthsView, "profile">;
type Cell = ClimbingStrengthsPanel["rows"][number]["cells"][number];
const palette = [colors.accent, "#bb7944", "#7688bc", "#ad658e", "#5e9d9a", "#9b8b44"];
function color(index: number) {
  return palette[index % palette.length] ?? colors.accent;
}
function rate(value: number | null | undefined) {
  return value == null ? "No data" : `${value}%`;
}
function facts(cell: Pick<Cell, "sends" | "climbs" | "successRate" | "sampleStatus">) {
  return `${rate(cell.successRate)} · ${cell.sends} sends / ${cell.climbs} climbs${cell.sampleStatus === "limited" ? " · Limited data" : ""}`;
}
const explanations: Record<ViewKind, string> = {
  gaps: "Success gap in percentage points from the same-grade baseline. Zero is the baseline.",
  curves: "Success rate by grade, from 0 to 100%. Missing observations leave gaps.",
  exposure:
    "Distinct climbs on the horizontal axis; success gap in percentage points from the same-grade baseline on the vertical axis.",
  pyramids:
    "Sent climbs overlaid on centered total-climb tracks, grouped by style from harder to easier grades. All tracks use the same count scale.",
  progress:
    "Success rate by calendar month in separate style charts on the same 0–100% scale. Missing months leave gaps. Monthly distinct climbs need not sum to the selected period.",
  radar:
    "Success rate from 0 to 100% on every axis. The dashed outline is the same-grade baseline.",
};

export function ClimbingStrengthsChart({
  panel,
  view,
  grade,
  onSelect,
}: {
  panel: ClimbingStrengthsPanel;
  view: ViewKind;
  grade: string;
  onSelect: (rowKey: string, grade: string) => void;
}) {
  const [width, setWidth] = useState(300);
  const baselineLabel = climbingStrengthsBaselineLabel(grade);
  const explanation = explanations[view].replaceAll(
    "same-grade baseline",
    baselineLabel.toLowerCase(),
  );
  const title =
    CLIMBING_STRENGTHS_VIEWS.find((entry) => entry.value === view)?.label ?? "Climbing strengths";
  const baseline = panel.grades.find((entry) => entry.grade === grade);
  const selected = panel.rows.flatMap((row, index) => {
    const cell = row.cells.find((entry) => entry.grade === grade);
    return cell ? [{ row, cell, index }] : [];
  });
  const exactRows =
    view === "progress"
      ? panel.progress.flatMap((month) =>
          month.rows.flatMap((row) =>
            row.cells.map((cell) => ({
              label: `${month.startDate}–${month.endDate} · ${panel.rows.find((entry) => entry.key === row.key)?.label ?? row.key} · ${cell.grade}`,
              value: facts(cell),
            })),
          ),
        )
      : panel.rows.flatMap((row) =>
          row.cells.map((cell) => ({
            label: `${row.label} · ${cell.grade}`,
            value: `${facts(cell)} · ${climbingStrengthsBaselineLabel(cell.grade)} ${rate(panel.grades.find((entry) => entry.grade === cell.grade)?.successRate)}${cell.differencePercentagePoints === null ? "" : ` · ${cell.differencePercentagePoints > 0 ? "+" : ""}${cell.differencePercentagePoints} percentage points`}`,
          })),
        );
  const usable = selected.filter(({ cell }) => cell.successRate !== null);
  const legendRows =
    view === "curves"
      ? panel.rows.map((row, index) => ({ row, index }))
      : view === "radar"
        ? usable
        : selected;
  const insufficientRadar = view === "radar" && usable.length < 3;
  const chartWidth = Math.max(
    width,
    (view === "curves" ? panel.grades.length : view === "progress" ? panel.progress.length : 0) *
      72,
  );
  const height =
    view === "pyramids"
      ? Math.max(180, panel.rows.length * (panel.grades.length * 32 + 36) + 32)
      : view === "progress"
        ? Math.max(190, panel.rows.length * 190)
        : view === "gaps"
          ? Math.max(180, selected.length * 44 + 48)
          : view === "radar"
            ? Math.max(300, selected.length * 20)
            : 270;
  const left = view === "gaps" ? 112 : 38;
  const right = chartWidth - 24;
  const top = 28;
  const bottom = height - 38;
  const plotWidth = Math.max(1, right - left);
  const yRate = (value: number) => bottom - (value / 100) * (bottom - top);
  const xAxis = (index: number, count: number) =>
    count < 2 ? (left + right) / 2 : left + (index / (count - 1)) * plotWidth;
  const maxCount = Math.max(
    1,
    ...panel.rows.flatMap((row) => row.cells.map((cell) => cell.climbs)),
  );
  const svgText = { fill: colors.textSecondary, fontSize: 10 };

  return (
    <View
      onLayout={(event) => {
        const measured = event.nativeEvent.layout.width;
        if (measured > 0) setWidth(measured);
      }}
      style={styles.container}
    >
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.meta}>{explanation}</Text>
      {insufficientRadar && (
        <Text style={styles.meta}>
          Radar needs at least three styles with recorded success rates for this grade.
        </Text>
      )}
      {(view === "gaps" || view === "exposure") && (
        <Text style={styles.meta}>Gap (percentage points)</Text>
      )}
      <AccessibleChart title={title} summary={`${grade}. ${explanation}`} rows={exactRows}>
        {!insufficientRadar && (
          <ScrollView horizontal contentContainerStyle={{ minWidth: width }}>
            <Svg width={chartWidth} height={height} viewBox={`0 0 ${chartWidth} ${height}`}>
              {view === "gaps" && (
                <>
                  <Line
                    x1={left + plotWidth / 2}
                    x2={left + plotWidth / 2}
                    y1={top}
                    y2={bottom}
                    stroke={colors.textTertiary}
                  />
                  <SvgText {...svgText} x={left} y={height - 12}>
                    −100
                  </SvgText>
                  <SvgText
                    {...svgText}
                    x={left + plotWidth / 2}
                    y={height - 12}
                    textAnchor="middle"
                  >
                    0
                  </SvgText>
                  <SvgText {...svgText} x={right} y={height - 12} textAnchor="end">
                    +100
                  </SvgText>
                  {selected.map(({ row, cell, index }) => {
                    const pointY = top + index * 44;
                    const gap = cell.differencePercentagePoints;
                    const center = left + plotWidth / 2;
                    return (
                      <G key={row.key}>
                        <SvgText {...svgText} x={4} y={pointY + 14}>
                          {row.label}
                        </SvgText>
                        {gap !== null ? (
                          <>
                            <Rect
                              x={center + Math.min(0, ((gap / 100) * plotWidth) / 2)}
                              y={pointY + 2}
                              width={((Math.abs(gap) / 100) * plotWidth) / 2}
                              height={18}
                              fill={color(index)}
                            />
                            <Circle
                              cx={center + ((gap / 100) * plotWidth) / 2}
                              cy={pointY + 11}
                              r={3}
                              fill={color(index)}
                            />
                          </>
                        ) : (
                          <SvgText {...svgText} x={center + 4} y={pointY + 14}>
                            No data
                          </SvgText>
                        )}
                      </G>
                    );
                  })}
                </>
              )}
              {view === "curves" && (
                <>
                  {[0, 50, 100].map((value) => (
                    <G key={value}>
                      <Line
                        x1={left}
                        x2={right}
                        y1={yRate(value)}
                        y2={yRate(value)}
                        stroke={colors.surfaceSecondary}
                      />
                      <SvgText {...svgText} x={2} y={yRate(value) + 4}>
                        {value}%
                      </SvgText>
                    </G>
                  ))}
                  {panel.grades.map((entry, index, labels) => (
                    <SvgText
                      {...svgText}
                      key={entry.grade}
                      x={xAxis(index, labels.length)}
                      y={height - 13}
                      textAnchor="middle"
                    >
                      {entry.grade}
                    </SvgText>
                  ))}
                  {panel.rows.map((row, rowIndex) => {
                    const cells = panel.grades.map((entry) =>
                      row.cells.find((cell) => cell.grade === entry.grade),
                    );
                    return (
                      <G key={row.key}>
                        {cells.map((cell, index) => {
                          if (cell?.successRate == null) return null;
                          const previous = cells[index - 1];
                          const pointX = xAxis(index, cells.length);
                          const pointY = yRate(cell.successRate);
                          return (
                            <G key={cell.grade}>
                              {previous?.successRate != null && (
                                <Line
                                  x1={xAxis(index - 1, cells.length)}
                                  y1={yRate(previous.successRate)}
                                  x2={pointX}
                                  y2={pointY}
                                  stroke={color(rowIndex)}
                                  strokeWidth={2}
                                />
                              )}
                              <Circle
                                onPress={() => onSelect(row.key, cell.grade)}
                                accessibilityLabel={`${row.label} · ${cell.grade} · ${facts(cell)}`}
                                cx={pointX}
                                cy={pointY}
                                r={cell.sampleStatus === "limited" ? 4 : 3}
                                fill={
                                  cell.sampleStatus === "limited" ? colors.surface : color(rowIndex)
                                }
                                stroke={color(rowIndex)}
                                strokeWidth={2}
                              />
                            </G>
                          );
                        })}
                      </G>
                    );
                  })}
                </>
              )}
              {view === "progress" &&
                panel.rows.map((row, rowIndex) => {
                  const chartTop = rowIndex * 190 + 30;
                  const chartBottom = chartTop + 120;
                  const monthY = (value: number) => chartBottom - (value / 100) * 120;
                  const cells = panel.progress.map((month) =>
                    month.rows
                      .find((entry) => entry.key === row.key)
                      ?.cells.find((cell) => cell.grade === grade),
                  );
                  return (
                    <G key={row.key} accessibilityLabel={`${row.label} progress`}>
                      <SvgText
                        fill={colors.text}
                        fontSize={12}
                        fontWeight="600"
                        x={left}
                        y={chartTop - 12}
                      >
                        {row.label}
                      </SvgText>
                      {[0, 50, 100].map((value) => (
                        <G key={value}>
                          <Line
                            x1={left}
                            x2={right}
                            y1={monthY(value)}
                            y2={monthY(value)}
                            stroke={colors.surfaceSecondary}
                          />
                          <SvgText {...svgText} x={2} y={monthY(value) + 4}>
                            {value}%
                          </SvgText>
                        </G>
                      ))}
                      {panel.progress.map((month, index) => (
                        <SvgText
                          {...svgText}
                          key={month.startDate}
                          x={xAxis(index, panel.progress.length)}
                          y={chartBottom + 19}
                          textAnchor="middle"
                        >
                          {month.startDate.slice(0, 7)}
                        </SvgText>
                      ))}
                      {cells.map((cell, index) => {
                        if (cell?.successRate == null) return null;
                        const previous = cells[index - 1];
                        return (
                          <G key={panel.progress[index]?.startDate}>
                            {previous?.successRate != null && (
                              <Line
                                x1={xAxis(index - 1, cells.length)}
                                y1={monthY(previous.successRate)}
                                x2={xAxis(index, cells.length)}
                                y2={monthY(cell.successRate)}
                                stroke={color(rowIndex)}
                                strokeWidth={2}
                              />
                            )}
                            <Circle
                              onPress={() => onSelect(row.key, cell.grade)}
                              accessibilityLabel={`${panel.progress[index]?.startDate} · ${row.label} · ${cell.grade} · ${facts(cell)}`}
                              cx={xAxis(index, cells.length)}
                              cy={monthY(cell.successRate)}
                              r={cell.sampleStatus === "limited" ? 4 : 3}
                              fill={
                                cell.sampleStatus === "limited" ? colors.surface : color(rowIndex)
                              }
                              stroke={color(rowIndex)}
                              strokeWidth={2}
                            />
                          </G>
                        );
                      })}
                    </G>
                  );
                })}
              {view === "exposure" && (
                <>
                  {[-100, 0, 100].map((value) => {
                    const pointY = top + ((100 - value) / 200) * (bottom - top);
                    return (
                      <G key={value}>
                        <Line
                          x1={left}
                          x2={right}
                          y1={pointY}
                          y2={pointY}
                          stroke={colors.surfaceSecondary}
                        />
                        <SvgText {...svgText} x={0} y={pointY + 4}>
                          {value}
                        </SvgText>
                      </G>
                    );
                  })}
                  <SvgText {...svgText} x={left} y={height - 12}>
                    0 climbs
                  </SvgText>
                  <SvgText {...svgText} x={right} y={height - 12} textAnchor="end">
                    {maxCount} climbs
                  </SvgText>
                  {selected.map(({ row, cell, index }) =>
                    cell.differencePercentagePoints === null ? null : (
                      <G key={row.key}>
                        <Circle
                          cx={left + (cell.climbs / maxCount) * plotWidth}
                          cy={
                            top + ((100 - cell.differencePercentagePoints) / 200) * (bottom - top)
                          }
                          r={7}
                          fill={color(index)}
                        />
                        <SvgText
                          {...svgText}
                          x={left + (cell.climbs / maxCount) * plotWidth}
                          y={
                            top +
                            ((100 - cell.differencePercentagePoints) / 200) * (bottom - top) -
                            11
                          }
                          textAnchor="middle"
                        >
                          {index + 1}
                        </SvgText>
                      </G>
                    ),
                  )}
                </>
              )}
              {view === "pyramids" && (
                <>
                  <SvgText {...svgText} x={right} y={16} textAnchor="end">
                    0–{maxCount} climbs · total / sent
                  </SvgText>
                  {panel.rows.map((row, rowIndex) => {
                    const groupTop = top + rowIndex * (panel.grades.length * 32 + 36);
                    const center = left + plotWidth / 2;
                    return (
                      <G key={row.key} accessibilityLabel={`${row.label} grade pyramid`}>
                        <SvgText
                          fill={colors.text}
                          fontSize={12}
                          fontWeight="600"
                          x={2}
                          y={groupTop + 8}
                        >
                          {row.label}
                        </SvgText>
                        {[...panel.grades].reverse().map((entry, gradeIndex) => {
                          const cell = row.cells.find((value) => value.grade === entry.grade);
                          if (!cell) return null;
                          const pointY = groupTop + 20 + gradeIndex * 32;
                          const totalWidth = (cell.climbs / maxCount) * plotWidth;
                          const sendWidth = (cell.sends / maxCount) * plotWidth;
                          return (
                            <G key={entry.grade}>
                              <SvgText {...svgText} x={2} y={pointY + 15}>
                                {entry.grade}
                              </SvgText>
                              <Rect
                                x={center - totalWidth / 2}
                                y={pointY + 2}
                                width={totalWidth}
                                height={20}
                                fill={colors.surfaceSecondary}
                              />
                              <Rect
                                x={center - sendWidth / 2}
                                y={pointY + 5}
                                width={sendWidth}
                                height={14}
                                fill={color(rowIndex)}
                              />
                              {cell.successRate === null && (
                                <SvgText
                                  {...svgText}
                                  x={center}
                                  y={pointY + 15}
                                  textAnchor="middle"
                                >
                                  No data
                                </SvgText>
                              )}
                            </G>
                          );
                        })}
                      </G>
                    );
                  })}
                </>
              )}
              {view === "radar" &&
                (() => {
                  const cx = chartWidth / 2;
                  const cy = height / 2;
                  const radius = Math.max(30, Math.min(chartWidth, height) / 2 - 45);
                  const point = (index: number, value: number) => {
                    const angle = (index / usable.length) * Math.PI * 2 - Math.PI / 2;
                    return {
                      x: cx + (Math.cos(angle) * radius * value) / 100,
                      y: cy + (Math.sin(angle) * radius * value) / 100,
                    };
                  };
                  const points = (value: (index: number) => number) =>
                    usable
                      .map((_, index) => {
                        const position = point(index, value(index));
                        return `${position.x},${position.y}`;
                      })
                      .join(" ");
                  return (
                    <>
                      {[50, 100].map((value) => (
                        <Polygon
                          key={value}
                          points={points(() => value)}
                          fill="none"
                          stroke={colors.surfaceSecondary}
                        />
                      ))}
                      {usable.map(({ row }, index) => {
                        const position = point(index, 100);
                        const label = point(index, 114);
                        return (
                          <G key={row.key}>
                            <Line
                              x1={cx}
                              x2={position.x}
                              y1={cy}
                              y2={position.y}
                              stroke={colors.surfaceSecondary}
                            />
                            <SvgText {...svgText} x={label.x} y={label.y} textAnchor="middle">
                              {index + 1}
                            </SvgText>
                          </G>
                        );
                      })}
                      {baseline?.successRate != null && (
                        <Polygon
                          points={points(() => baseline.successRate ?? 0)}
                          fill="none"
                          stroke={colors.textSecondary}
                          strokeDasharray="5 4"
                        />
                      )}
                      <Polygon
                        points={points((index) => usable[index]?.cell.successRate ?? 0)}
                        fill={colors.accent}
                        fillOpacity={0.2}
                        stroke={colors.accent}
                        strokeWidth={2}
                      />
                      <SvgText {...svgText} x={cx + 3} y={cy + 12}>
                        0%
                      </SvgText>
                      <SvgText {...svgText} x={cx + 10} y={cy - radius + 14}>
                        100%
                      </SvgText>
                    </>
                  );
                })()}
            </Svg>
          </ScrollView>
        )}
      </AccessibleChart>
      {(view === "curves" || view === "exposure" || view === "radar") && (
        <View style={styles.legend}>
          {legendRows.map(({ row, index }, axis) => (
            <Text key={row.key} style={[styles.meta, { color: color(index) }]}>
              {view === "exposure" || view === "radar" ? `${axis + 1}. ` : ""}
              {row.label}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  container: { gap: 10 },
  title: { color: colors.text, fontSize: 16, fontWeight: "600" },
  meta: { color: colors.textSecondary, fontSize: 12 },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
});
