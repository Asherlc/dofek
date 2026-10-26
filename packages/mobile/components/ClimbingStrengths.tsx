import type {
  ClimbingStrengthsCell,
  ClimbingStrengthsPanel,
  ClimbingStrengths as Strengths,
} from "@dofek/training/climbing-strengths";
import {
  ALL_CLIMBING_GRADES,
  climbingStrengthsBaselineLabel,
  climbingStrengthsCountLabel,
  climbingStrengthsGradePanel,
  climbingStrengthsRateLabel,
  climbingStrengthsResultLabel,
} from "@dofek/training/climbing-strengths";
import type { ClimbingStrengthsView } from "@dofek/training/climbing-strengths-views";
import { useRouter } from "expo-router";
import { type ReactNode, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Rect } from "react-native-svg";
import { openExternalUrl } from "../lib/open-external-url";
import { colors, radius, spacing } from "../theme";
import { ClimbingStrengthsChart } from "./ClimbingStrengthsChart";
import { ClimbingStrengthsViewPicker } from "./ClimbingStrengthsViewPicker";
import { QueryStatePanel } from "./QueryStatePanel";

const dimensions = {
  wall_angle: "Wall angle",
  hold_type: "Hold type",
  setting: "Indoor / outdoor",
} as const;
function observed(panel: ClimbingStrengthsPanel) {
  return panel.rows.some((row) => row.cells.some((cell) => cell.sampleStatus !== "no_data"));
}
function defaultPanel(panels: ClimbingStrengthsPanel[]) {
  return (
    panels.find((panel) => panel.dimension === "wall_angle" && observed(panel)) ??
    panels.find((panel) => panel.dimension === "setting" && observed(panel)) ??
    panels.find(observed) ??
    panels[0]
  );
}
function cellLabel(label: string, cell: ClimbingStrengthsCell) {
  return cell.sampleStatus === "no_data"
    ? `${label} · No data`
    : `${label} · ${climbingStrengthsRateLabel(cell)} · ${climbingStrengthsCountLabel(cell)}${cell.differencePercentagePoints === null ? "" : ` · ${cell.differencePercentagePoints > 0 ? "+" : ""}${cell.differencePercentagePoints} percentage points vs ${climbingStrengthsBaselineLabel(cell.grade).toLowerCase()}`}`;
}
export function ClimbingStrengths({
  data,
  loading = false,
  error,
  rangeControl,
}: {
  data: Strengths | undefined;
  loading?: boolean;
  error?: { message: string } | null;
  rangeControl?: ReactNode;
}) {
  const [view, setView] = useState<ClimbingStrengthsView>("profile");
  const [selectedDimension, setDimension] = useState<ClimbingStrengthsPanel["dimension"] | null>(
    null,
  );
  const panels = data?.panels ?? [];
  const dimension = selectedDimension ?? defaultPanel(panels)?.dimension ?? "wall_angle";
  const contexts = [
    ...new Map(panels.map((panel) => [panel.contextKey, panel.contextLabel])).entries(),
  ];
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Climbing strengths</Text>
      {rangeControl}
      {error && <QueryStatePanel variant="error" message={error.message} minHeight={80} />}
      {panels.length ? (
        <>
          <ClimbingStrengthsViewPicker value={view} onChange={setView} />
          <View style={styles.controls}>
            {Object.entries(dimensions).map(([item, label]) => (
              <Pressable
                key={item}
                accessibilityRole="button"
                accessibilityState={{ selected: dimension === item }}
                style={[styles.chip, dimension === item && styles.selected]}
                onPress={() => {
                  if (item === "wall_angle" || item === "hold_type" || item === "setting")
                    setDimension(item);
                }}
              >
                <Text style={styles.text}>{label}</Text>
              </Pressable>
            ))}
          </View>
          {panels.some((panel) => panel.grades.some((grade) => grade.unknownOutcomes > 0)) ? (
            <Text style={styles.meta}>Success rates use climbs with known results.</Text>
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
        </>
      ) : loading && data == null ? (
        <QueryStatePanel variant="loading" />
      ) : !error ? (
        <QueryStatePanel variant="empty" message="No recorded climbing outcomes in this period" />
      ) : null}
    </View>
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
  const grade = grades.find((item) => item.grade === gradeKey)?.grade ?? ALL_CLIMBING_GRADES;
  return (
    <View style={{ gap: spacing.md }}>
      {label ? (
        <Text accessibilityRole="header" style={styles.text}>
          {label}
        </Text>
      ) : null}
      {grades.length > 0 ? (
        <View style={styles.controls}>
          {[ALL_CLIMBING_GRADES, ...grades.map((item) => item.grade)].map((item) => (
            <Pressable
              key={item}
              accessibilityRole="button"
              accessibilityState={{ selected: grade === item }}
              style={[styles.chip, grade === item && styles.selected]}
              onPress={() => setGradeKey(item)}
            >
              <Text style={styles.text}>{item}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {selectedPanels.length ? (
        selectedPanels.map((panel) => (
          <View key={panel.key} style={{ gap: spacing.md }}>
            {dimension !== "setting" && selectedPanels.length > 1 && panel.setting ? (
              <Text accessibilityRole="header" style={styles.text}>
                {panel.setting === "indoor"
                  ? "Indoor"
                  : panel.setting === "outdoor"
                    ? "Outdoor"
                    : "Setting unknown"}
              </Text>
            ) : null}
            <ClimbingStrengthsPanelContent
              panel={panel}
              view={view}
              selectedGradeKey={grade}
              onGradeChange={setGradeKey}
            />
          </View>
        ))
      ) : (
        <Text style={styles.meta}>
          {`No recorded ${dimensions[dimension].toLowerCase()} observations in this context.`}
        </Text>
      )}
    </View>
  );
}

function ClimbingStrengthsPanelContent({
  panel,
  view,
  selectedGradeKey,
  onGradeChange,
}: {
  panel: ClimbingStrengthsPanel;
  view: ClimbingStrengthsView;
  selectedGradeKey: string;
  onGradeChange: (grade: string) => void;
}) {
  const router = useRouter();
  const [selectedDetail, setSelectedDetail] = useState<{ rowKey: string; grade: string } | null>(
    null,
  );
  const gradePanel = climbingStrengthsGradePanel(panel, selectedGradeKey);
  const selectedGrade = gradePanel.grades.find((item) => item.grade === selectedGradeKey);
  const selectedCell =
    selectedDetail?.grade === selectedGrade?.grade
      ? gradePanel.rows
          .find((row) => row.key === selectedDetail?.rowKey)
          ?.cells.find((cell) => cell.grade === selectedDetail?.grade)
      : undefined;
  const selectedRowKey = selectedCell ? selectedDetail?.rowKey : null;
  if (!observed(panel))
    return (
      <Text
        style={styles.meta}
      >{`No recorded ${dimensions[panel.dimension].toLowerCase()} observations in this context.`}</Text>
    );
  return (
    <View style={{ gap: spacing.md }}>
      {view !== "profile" && (selectedGrade || view === "curves" || view === "pyramids") && (
        <ClimbingStrengthsChart
          panel={view === "curves" || view === "pyramids" ? panel : (gradePanel ?? panel)}
          view={view}
          grade={selectedGradeKey}
          onSelect={(row, selected) => {
            setSelectedDetail({ rowKey: row, grade: selected });
            onGradeChange(selected);
          }}
        />
      )}
      {selectedGrade ? (
        <>
          <Text style={styles.meta}>
            {selectedGradeKey === ALL_CLIMBING_GRADES ? "Overall" : "Same-grade"} baseline ·{" "}
            {climbingStrengthsRateLabel(selectedGrade)} ·{" "}
            {climbingStrengthsCountLabel(selectedGrade)}
          </Text>
          {(gradePanel?.rows ?? []).map((row) => {
            const cell = row.cells.find((item) => item.grade === selectedGrade.grade);
            return cell ? (
              <Pressable
                key={row.key}
                accessibilityRole="button"
                accessibilityLabel={cellLabel(row.label, cell)}
                accessibilityState={{ selected: selectedRowKey === row.key }}
                style={[styles.row, selectedRowKey === row.key && styles.selected]}
                onPress={() =>
                  setSelectedDetail({
                    rowKey: row.key,
                    grade: selectedGrade.grade,
                  })
                }
              >
                <View style={styles.rowHeading}>
                  <Text style={styles.text}>{row.label}</Text>
                  <Text style={styles.text}>{climbingStrengthsRateLabel(cell)}</Text>
                </View>
                {view === "profile" && (
                  <Svg height={8} width="100%" accessibilityElementsHidden>
                    <Rect width="100%" height={8} rx={4} fill={colors.surfaceSecondary} />
                    {cell.successRate !== null && (
                      <Rect
                        testID={`strength-bar-${row.key}`}
                        width={`${cell.successRate}%`}
                        height={8}
                        rx={4}
                        fill={colors.accent}
                      />
                    )}
                    {selectedGrade.successRate !== null && (
                      <Rect
                        testID={`strength-baseline-${row.key}`}
                        x={`${selectedGrade.successRate}%`}
                        width={2}
                        height={8}
                        fill={colors.text}
                      />
                    )}
                  </Svg>
                )}
                <Text style={styles.meta}>
                  {cell.sampleStatus === "no_data" ? "No data" : climbingStrengthsCountLabel(cell)}
                </Text>
                {cell.differencePercentagePoints !== null && (
                  <Text style={styles.meta}>
                    {cell.differencePercentagePoints > 0 ? "+" : ""}
                    {cell.differencePercentagePoints} percentage points vs{" "}
                    {selectedGradeKey === ALL_CLIMBING_GRADES ? "overall" : "same-grade"} baseline
                  </Text>
                )}
              </Pressable>
            ) : null;
          })}
          {selectedCell && (
            <View style={styles.examples}>
              <Text style={styles.text}>
                {view === "progress"
                  ? "Recorded climbs · Across the selected period"
                  : "Recorded climbs"}
              </Text>
              {selectedCell.examples.length === 0 ? (
                <Text style={styles.meta}>No examples available for this selection.</Text>
              ) : (
                selectedCell.examples.map((example) => (
                  <View key={example.logEntryId} style={styles.row}>
                    <Text style={styles.text}>{example.name}</Text>
                    <Text style={styles.meta}>
                      {example.grade} · {example.date} ·{" "}
                      {climbingStrengthsResultLabel(example.outcome)}
                    </Text>
                    {example.sourceUrl ? (
                      <Pressable
                        accessibilityRole="link"
                        accessibilityLabel={`${example.sourceName} source for ${example.name}`}
                        style={styles.chip}
                        onPress={async () => {
                          if (
                            example.sourceUrl &&
                            !(await openExternalUrl(example.sourceUrl, "climbing-strengths-source"))
                          )
                            Alert.alert(
                              "Unable to open source",
                              `Open this source in your browser: ${example.sourceUrl}`,
                            );
                        }}
                      >
                        <Text style={styles.link}>{example.sourceName}</Text>
                      </Pressable>
                    ) : (
                      <Text style={styles.meta}>{example.sourceName}</Text>
                    )}
                    {example.activityId && (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`View activity for ${example.name}`}
                        onPress={() => router.push(`/activity/${example.activityId}`)}
                        style={styles.chip}
                      >
                        <Text style={styles.link}>View activity</Text>
                      </Pressable>
                    )}
                  </View>
                ))
              )}
            </View>
          )}
        </>
      ) : view === "curves" || view === "pyramids" ? null : (
        <QueryStatePanel variant="empty" message="No recorded climbing outcomes in this context" />
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.md,
    gap: spacing.md,
  },
  title: { color: colors.text, fontSize: 18, fontWeight: "600" },
  controls: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  chip: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSecondary,
  },
  selected: { borderColor: colors.accent, borderWidth: 1 },
  text: { color: colors.text, fontSize: 14 },
  meta: { color: colors.textSecondary, fontSize: 12 },
  row: { padding: spacing.sm, borderRadius: radius.md, gap: spacing.xs },
  rowHeading: { flexDirection: "row", justifyContent: "space-between" },
  examples: { gap: spacing.sm },
  link: { color: colors.accent, fontSize: 13 },
});
