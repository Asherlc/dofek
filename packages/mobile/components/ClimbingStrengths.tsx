import type {
  ClimbingStrengthsCell,
  ClimbingStrengthsPanel,
  ClimbingStrengths as Strengths,
} from "@dofek/training/climbing-strengths";
import type { ClimbingStrengthsView } from "@dofek/training/climbing-strengths-views";
import { useRouter } from "expo-router";
import { useState } from "react";
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
    : `${label} · ${cell.successRate}% · ${cell.sends}/${cell.climbs} climbs sent${cell.sampleStatus === "limited" ? " · Limited data" : ""}${cell.differencePercentagePoints === null ? "" : ` · ${cell.differencePercentagePoints > 0 ? "+" : ""}${cell.differencePercentagePoints} percentage points vs same-grade baseline`}`;
}
export function ClimbingStrengths({
  data,
  loading = false,
  error,
}: {
  data: Strengths | undefined;
  loading?: boolean;
  error?: { message: string } | null;
}) {
  const router = useRouter();
  const [view, setView] = useState<ClimbingStrengthsView>("profile");
  const [panelKey, setPanelKey] = useState<string | null>(null);
  const [preferredSetting, setPreferredSetting] = useState<"indoor" | "outdoor" | null>(null);
  const [grade, setGrade] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<{
    panelKey: string;
    rowKey: string;
    grade: string;
  } | null>(null);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const panels = data?.panels ?? [];
  const panel = panels.find((item) => item.key === panelKey) ?? defaultPanel(panels);
  const selectedGrade = panel?.grades.find((item) => item.grade === grade) ?? panel?.grades[0];
  const contextPanels = panels.filter((item) => item.contextKey === panel?.contextKey);
  const contexts = panels.filter(
    (item, index) => panels.findIndex((other) => other.contextKey === item.contextKey) === index,
  );
  const selectedCell =
    selectedDetail &&
    selectedDetail.panelKey === panel?.key &&
    selectedDetail.grade === selectedGrade?.grade
      ? panel.rows
          .find((row) => row.key === selectedDetail.rowKey)
          ?.cells.find((cell) => cell.grade === selectedDetail.grade)
      : undefined;
  const selectedRowKey = selectedCell ? selectedDetail?.rowKey : null;
  function selectPanel(next: ClimbingStrengthsPanel | undefined) {
    if (next) {
      if (next.dimension === "setting" && panel?.setting) setPreferredSetting(panel.setting);
      setPanelKey(next.key);
      if (next.setting !== null) setPreferredSetting(next.setting);
      setSelectedDetail(null);
    }
  }
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Climbing strengths</Text>
      {error && <QueryStatePanel variant="error" message={error.message} minHeight={80} />}
      {panel ? (
        <>
          <ClimbingStrengthsViewPicker value={view} onChange={setView} />
          <View style={styles.controls}>
            {contexts.map((context) => (
              <Pressable
                key={context.contextKey}
                accessibilityRole="button"
                accessibilityState={{ selected: context.contextKey === panel.contextKey }}
                style={[styles.chip, context.contextKey === panel.contextKey && styles.selected]}
                onPress={() =>
                  selectPanel(
                    contextPanels[0]?.contextKey === context.contextKey
                      ? panel
                      : defaultPanel(
                          panels.filter((item) => item.contextKey === context.contextKey),
                        ),
                  )
                }
              >
                <Text style={styles.text}>{context.contextLabel}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.controls}>
            {Object.entries(dimensions).map(([dimension, label]) => (
              <Pressable
                key={dimension}
                accessibilityRole="button"
                accessibilityState={{ selected: panel.dimension === dimension }}
                disabled={!contextPanels.some((item) => item.dimension === dimension)}
                style={[styles.chip, panel.dimension === dimension && styles.selected]}
                onPress={() =>
                  selectPanel(
                    contextPanels.find(
                      (item) =>
                        item.dimension === dimension &&
                        item.setting === (panel.setting ?? preferredSetting),
                    ) ?? contextPanels.find((item) => item.dimension === dimension),
                  )
                }
              >
                <Text style={styles.text}>{label}</Text>
              </Pressable>
            ))}
          </View>
          {panel.dimension !== "setting" && (
            <View style={styles.controls}>
              {contextPanels
                .filter((item) => item.dimension === panel.dimension)
                .map((item) => (
                  <Pressable
                    key={item.key}
                    accessibilityRole="button"
                    accessibilityState={{ selected: item.key === panel.key }}
                    style={[styles.chip, item.key === panel.key && styles.selected]}
                    onPress={() => selectPanel(item)}
                  >
                    <Text style={styles.text}>
                      {item.setting === "indoor" ? "Indoor" : "Outdoor"}
                    </Text>
                  </Pressable>
                ))}
            </View>
          )}
          {selectedGrade ? (
            <>
              <View style={styles.controls}>
                {panel.grades.map((item) => (
                  <Pressable
                    key={item.grade}
                    accessibilityRole="button"
                    accessibilityState={{ selected: selectedGrade.grade === item.grade }}
                    style={[styles.chip, selectedGrade.grade === item.grade && styles.selected]}
                    onPress={() => {
                      setGrade(item.grade);
                      setSelectedDetail(null);
                    }}
                  >
                    <Text style={styles.text}>{item.grade}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.meta}>
                Same-grade baseline ·{" "}
                {selectedGrade.successRate === null ? "No data" : `${selectedGrade.successRate}%`} ·{" "}
                {selectedGrade.sends}/{selectedGrade.climbs} climbs sent
              </Text>
              {view !== "profile" && (
                <ClimbingStrengthsChart
                  panel={panel}
                  view={view}
                  grade={selectedGrade.grade}
                  onSelect={(row, selected) => {
                    setSelectedDetail({ panelKey: panel.key, rowKey: row, grade: selected });
                    setGrade(selected);
                  }}
                />
              )}
              {view !== "profile" && (
                <Text style={styles.meta}>
                  Select a grade and style to see its recorded climbs.
                </Text>
              )}
              {panel.rows.map((row) => {
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
                        panelKey: panel.key,
                        rowKey: row.key,
                        grade: selectedGrade.grade,
                      })
                    }
                  >
                    <View style={styles.rowHeading}>
                      <Text style={styles.text}>{row.label}</Text>
                      <Text style={styles.text}>
                        {cell.successRate === null ? "—" : `${cell.successRate}%`}
                      </Text>
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
                      {cell.sampleStatus === "no_data"
                        ? "No data"
                        : `${cell.sends}/${cell.climbs} climbs sent${cell.sampleStatus === "limited" ? " · Limited data" : ""}`}
                    </Text>
                    {cell.differencePercentagePoints !== null && (
                      <Text style={styles.meta}>
                        {cell.differencePercentagePoints > 0 ? "+" : ""}
                        {cell.differencePercentagePoints} percentage points vs same-grade baseline
                      </Text>
                    )}
                  </Pressable>
                ) : null;
              })}
              {!observed(panel) && (
                <Text style={styles.meta}>
                  No recorded {dimensions[panel.dimension].toLowerCase()} observations in this
                  context.
                </Text>
              )}
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
                          {example.outcome === "sent" ? "Sent" : "Not sent"}
                        </Text>
                        {example.sourceUrl ? (
                          <Pressable
                            accessibilityRole="link"
                            accessibilityLabel={`${example.sourceName} source for ${example.name}`}
                            style={styles.chip}
                            onPress={async () => {
                              if (
                                example.sourceUrl &&
                                !(await openExternalUrl(
                                  example.sourceUrl,
                                  "climbing-strengths-source",
                                ))
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
          ) : (
            <QueryStatePanel
              variant="empty"
              message="No recorded climbing outcomes in this context"
            />
          )}
        </>
      ) : loading && data == null ? (
        <QueryStatePanel variant="loading" />
      ) : !error ? (
        <QueryStatePanel variant="empty" message="No recorded climbing outcomes in this period" />
      ) : null}
      {data && (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Coverage details"
            accessibilityState={{ expanded: coverageOpen }}
            onPress={() => setCoverageOpen(!coverageOpen)}
            style={styles.chip}
          >
            <Text style={styles.link}>Coverage details {coverageOpen ? "−" : "+"}</Text>
          </Pressable>
          {coverageOpen && (
            <View style={styles.examples}>
              {panel && (
                <>
                  <Text style={styles.meta}>Missing traits: {panel.coverage.missingTraits}</Text>
                  <Text style={styles.meta}>
                    Unknown outcomes in this context: {panel.coverage.unknownOutcomes}
                  </Text>
                </>
              )}
              <Text style={styles.meta}>Unknown outcomes: {data.coverage.unknownOutcomes}</Text>
              <Text style={styles.meta}>
                Records with missing or conflicting grades: {data.coverage.missingGrades}
              </Text>
              <Text style={styles.meta}>Unidentified records: {data.coverage.missingIdentity}</Text>
            </View>
          )}
        </>
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
