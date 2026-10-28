import { climbingProgressionSettingLabels } from "@dofek/training/climbing-progression";
import type {
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
import { useRouter } from "expo-router";
import { type ReactNode, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { openExternalUrl } from "../lib/open-external-url";
import { colors, radius, spacing } from "../theme";
import { ClimbingStrengthsChart } from "./ClimbingStrengthsChart";
import { QueryStatePanel } from "./QueryStatePanel";

const dimensions = {
  wall_angle: "Wall angle",
  hold_type: "Hold type",
  setting: "Setting",
} as const;
function observed(panel: ClimbingStrengthsPanel) {
  return panel.rows.some((row) => row.cells.some((cell) => cell.sampleStatus !== "no_data"));
}
function defaultPanel(panels: ClimbingStrengthsPanel[]) {
  return (
    panels.find((panel) => panel.dimension === "wall_angle" && observed(panel)) ??
    panels.find((panel) => panel.dimension === "hold_type" && observed(panel)) ??
    panels.find((panel) => panel.dimension !== "setting")
  );
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
  const [view, setView] = useState<ClimbingStrengthsTab>("radar");
  const [selectedDimension, setDimension] = useState<ClimbingStrengthsPanel["dimension"] | null>(
    null,
  );
  const panels = data?.panels ?? [];
  const dimension = selectedDimension ?? defaultPanel(panels)?.dimension ?? "wall_angle";
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Climbing strengths</Text>
      {rangeControl ? <Text style={styles.meta}>Strengths period</Text> : null}
      {rangeControl}
      {error && <QueryStatePanel variant="error" message={error.message} minHeight={80} />}
      {data != null || !loading ? (
        <>
          <Text style={styles.meta}>Break down by</Text>
          <View style={styles.controls}>
            {Object.entries(dimensions)
              .filter(([item]) => item !== "setting")
              .map(([item, label]) => (
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
          <View style={styles.controls}>
            {CLIMBING_STRENGTHS_TABS.map((tab) => (
              <Pressable
                key={tab.value}
                accessibilityRole="button"
                accessibilityState={{ selected: view === tab.value }}
                onPress={() => setView(tab.value)}
                style={[styles.chip, view === tab.value && styles.selected]}
              >
                <Text style={styles.text}>{tab.label}</Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
      {panels.length ? (
        <>
          {panels.some((panel) => panel.grades.some((grade) => grade.unknownOutcomes > 0)) ? (
            <Text style={styles.meta}>Success rates use climbs with known results.</Text>
          ) : null}
          <ClimbingStrengthsBreakdown panels={panels} dimension={dimension} view={view} />
        </>
      ) : loading && data == null ? (
        <QueryStatePanel variant="loading" />
      ) : !error ? (
        <QueryStatePanel variant="empty" message="No recorded climbing outcomes in this period" />
      ) : null}
    </View>
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
    <View style={{ gap: spacing.md }}>
      {selectedPanels.length ? (
        selectedPanels.map((panel) => (
          <View
            key={panel.key}
            accessibilityLabel={`${panel.contextLabel} · ${climbingProgressionSettingLabels[panel.setting ?? "unknown"]}`}
            style={{ gap: spacing.md }}
          >
            <Text accessibilityRole="header" style={styles.sectionTitle}>
              {panel.contextLabel} · {climbingProgressionSettingLabels[panel.setting ?? "unknown"]}
            </Text>
            <ClimbingStrengthsPanelContent panel={panel} view={view} />
          </View>
        ))
      ) : (
        <Text
          style={styles.meta}
        >{`No recorded ${dimensions[dimension].toLowerCase()} observations in this context.`}</Text>
      )}
    </View>
  );
}

function ClimbingStrengthsPanelContent({
  panel,
  view,
}: {
  panel: ClimbingStrengthsPanel;
  view: ClimbingStrengthsTab;
}) {
  const router = useRouter();
  const [selectedDetail, setSelectedDetail] = useState<{ rowKey: string; grade: string } | null>(
    null,
  );
  const displayPanel =
    view === "profile" ? panel : climbingStrengthsGradePanel(panel, ALL_CLIMBING_GRADES);
  const selectedRow = displayPanel.rows.find((row) => row.key === selectedDetail?.rowKey);
  const selectedCell = selectedRow?.cells.find((cell) => cell.grade === selectedDetail?.grade);
  if (!observed(panel))
    return (
      <Text
        style={styles.meta}
      >{`No recorded ${dimensions[panel.dimension].toLowerCase()} observations in this context.`}</Text>
    );
  return (
    <View style={{ gap: spacing.md }}>
      {view === "profile" ? (
        <>
          <Text style={styles.text}>Send rate by grade and style</Text>
          <View style={{ gap: spacing.md }}>
            {panel.grades.map((grade) => (
              <View
                key={grade.grade}
                accessibilityLabel={`${grade.grade} send rates`}
                style={{ gap: spacing.xs }}
              >
                <Text accessibilityRole="header" style={styles.sectionTitle}>
                  {grade.grade}
                </Text>
                <View style={styles.gradeStyles}>
                  {panel.rows.flatMap((row) => {
                    const cell = row.cells.find((cell) => cell.grade === grade.grade);
                    return cell
                      ? [
                          <Pressable
                            key={row.key}
                            accessibilityRole="button"
                            accessibilityLabel={`${row.label} · ${cell.grade} · ${climbingStrengthsRateLabel(cell)} · ${climbingStrengthsCountLabel(cell)}${cell.sampleStatus === "limited" ? " · Limited sample" : ""}`}
                            accessibilityState={{
                              selected:
                                selectedRow?.key === row.key && selectedCell?.grade === cell.grade,
                            }}
                            onPress={() =>
                              setSelectedDetail({ rowKey: row.key, grade: cell.grade })
                            }
                            style={[
                              styles.gradeCell,
                              selectedRow?.key === row.key &&
                                selectedCell?.grade === cell.grade &&
                                styles.selected,
                            ]}
                          >
                            <View
                              pointerEvents="none"
                              style={[
                                StyleSheet.absoluteFill,
                                {
                                  backgroundColor: colors.accent,
                                  opacity: cell.successRate === null ? 0 : cell.successRate * 0.004,
                                },
                              ]}
                            />
                            <Text style={styles.meta}>{row.label}</Text>
                            <Text style={styles.text}>{climbingStrengthsRateLabel(cell)}</Text>
                            {cell.sampleStatus === "limited" ? (
                              <Text style={styles.meta}>Limited sample</Text>
                            ) : null}
                          </Pressable>,
                        ]
                      : [];
                  })}
                </View>
              </View>
            ))}
          </View>
        </>
      ) : (
        <>
          {view === "radar" ? (
            <Text style={styles.meta}>
              Compared with your usual results at the same grades. Outside the dashed line is
              stronger; inside is weaker.
            </Text>
          ) : (
            <Text style={styles.meta}>
              Combines all grades; changes can reflect the difficulty of climbs recorded each month.
            </Text>
          )}
          <ClimbingStrengthsChart
            panel={displayPanel}
            view={view}
            grade={ALL_CLIMBING_GRADES}
            onSelect={(rowKey, grade) => setSelectedDetail({ rowKey, grade })}
          />
        </>
      )}
      {selectedCell && (
        <View style={styles.examples}>
          <Text style={styles.text}>
            {selectedRow?.label} · {selectedCell.grade}
          </Text>
          {view === "radar" ? (
            <Text style={styles.meta}>
              {climbingStrengthsDifferenceLabel(
                panel.gradeAdjustedStrengths.find((entry) => entry.key === selectedRow?.key)
                  ?.differencePercentagePoints ?? null,
              )}
            </Text>
          ) : null}
          <Text style={styles.meta}>
            {climbingStrengthsRateLabel(selectedCell)} · {climbingStrengthsCountLabel(selectedCell)}
          </Text>
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
                  {example.grade} · {example.date} · {climbingStrengthsResultLabel(example.outcome)}
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
    </View>
  );
}
const styles = StyleSheet.create({
  gradeStyles: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  gradeCell: {
    flexGrow: 1,
    flexBasis: 108,
    minWidth: 0,
    padding: spacing.sm,
    minHeight: 64,
    justifyContent: "center",
    gap: spacing.xs,
    borderRadius: radius.md,
    overflow: "hidden",
    backgroundColor: colors.surfaceSecondary,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.md,
    gap: spacing.md,
  },
  title: { color: colors.text, fontSize: 18, fontWeight: "600" },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
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
  examples: { gap: spacing.sm },
  link: { color: colors.accent, fontSize: 13 },
});
