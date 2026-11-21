import { formatDateMedium, formatDateShort } from "@dofek/format/format";
import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import type {
  ClimbingDemonstratedGrade as ClimbingDemonstratedGradeData,
  DemonstratedGradeCell,
  DemonstratedGradeSend,
} from "@dofek/training/climbing-demonstrated-grade";
import { gradeSystemLabel } from "@dofek/training/climbing-grades";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Linking, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { captureException } from "../lib/telemetry";
import { colors } from "../theme";

const TYPES = [
  { key: "bouldering", label: "Bouldering", spoken: "bouldering" },
  { key: "lead", label: "Lead", spoken: "lead" },
  { key: "top_rope", label: "Top rope", spoken: "top rope" },
  { key: "unroped", label: "Unroped", spoken: "unroped" },
] as const;
const SETTINGS = [
  { key: "indoor", label: "Indoor", spoken: "indoor" },
  { key: "outdoor", label: "Outdoor", spoken: "outdoor" },
] as const;

type CellKey = `${(typeof TYPES)[number]["key"]}-${(typeof SETTINGS)[number]["key"]}`;

function cellKey<T extends string, S extends string>(type: T, setting: S): `${T}-${S}` {
  return `${type}-${setting}`;
}

function gradeCell(cells: readonly DemonstratedGradeCell[], key: CellKey) {
  const [type, setting] = key.split("-");
  return cells.find((cell) => cell.type === type && cell.setting === setting);
}

function firstAvailableKey(data: ClimbingDemonstratedGradeData | null | undefined): CellKey | null {
  if (!data) return null;
  for (const type of TYPES) {
    for (const setting of SETTINGS) {
      const key = cellKey(type.key, setting.key);
      if ((gradeCell(data.cells, key)?.grades.length ?? 0) > 0) return key;
    }
  }
  return null;
}

function methodLabel(method: DemonstratedGradeSend["ropeMethod"]): string | null {
  if (method === "follow") return "Follow";
  if (method === "top_rope") return "Top rope";
  if (method === "lead") return "Lead";
  if (method === "unroped") return "Unroped";
  return null;
}

function ascentStyleLabel(send: DemonstratedGradeSend, includeMethod: boolean): string {
  const method = includeMethod ? methodLabel(send.ropeMethod) : null;
  if (send.ascentStyle && method) return `${send.ascentStyle} · ${method}`;
  if (send.ascentStyle) return send.ascentStyle;
  if (method) return method;
  return "Ascent style unknown";
}

export function ClimbingDemonstratedGrade({
  data,
  loading = false,
  error = null,
}: {
  data?: ClimbingDemonstratedGradeData | null;
  loading?: boolean;
  error?: { message: string } | null;
}) {
  const router = useRouter();
  // `undefined` means "no choice yet"; `null` means the reader closed every panel.
  const [chosenKey, setChosenKey] = useState<CellKey | null | undefined>(undefined);
  const [methodOpen, setMethodOpen] = useState(false);
  const openKey =
    chosenKey === null
      ? null
      : chosenKey !== undefined && (gradeCell(data?.cells ?? [], chosenKey)?.grades.length ?? 0) > 0
        ? chosenKey
        : firstAvailableKey(data);

  if (loading && !data) {
    return <Text style={styles.state}>Loading demonstrated grades…</Text>;
  }
  if (error && !data) {
    return (
      <Text accessibilityRole="alert" style={styles.errorText}>
        {userFacingErrorMessage(error, "Demonstrated grades could not be loaded.")}
      </Text>
    );
  }
  if (!data) {
    return <Text style={styles.state}>No demonstrated grades in this period.</Text>;
  }

  const bounded =
    !data.coverage.fullWindow && data.coverage.startDate && data.coverage.endDate
      ? { start: data.coverage.startDate, end: data.coverage.endDate }
      : { start: data.startDate, end: data.endDate };
  const windowLabel = `${formatDateShort(bounded.start)} – ${formatDateMedium(bounded.end)}`;
  const qualifier = data.coverage.fullWindow
    ? null
    : data.coverage.startDate && data.coverage.endDate
      ? "Limited to the climbing history available to your account."
      : "No climbing history is available to your account for this period.";
  const countWord = data.minimumDistinctClimbs === 3 ? "three" : String(data.minimumDistinctClimbs);
  const hasAnyGrade = data.cells.some((cell) => cell.grades.length > 0);

  return (
    <View style={styles.container}>
      <View style={styles.heading}>
        <Text accessibilityRole="header" style={styles.title}>
          Demonstrated grade
        </Text>
        <Text style={styles.window}>{windowLabel}</Text>
      </View>
      <Text style={styles.explanation}>
        Highest published grade sent on {countWord} different climbs in the past three months.
      </Text>
      {qualifier ? <Text style={styles.qualifier}>{qualifier}</Text> : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {userFacingErrorMessage(error, "Demonstrated grades could not be loaded.")}
        </Text>
      ) : null}
      {!hasAnyGrade ? (
        <Text style={styles.state}>No demonstrated grades in this period.</Text>
      ) : null}

      <View style={styles.matrix}>
        <View style={styles.row}>
          <Text style={[styles.cell, styles.rowLabel]}>Climbing type</Text>
          {SETTINGS.map((setting) => (
            <Text key={setting.key} style={[styles.cell, styles.columnLabel]}>
              {setting.label}
            </Text>
          ))}
        </View>
        {TYPES.map((type) => (
          <View key={type.key} style={styles.row}>
            <Text style={[styles.cell, styles.rowLabel]}>{type.label}</Text>
            {SETTINGS.map((setting) => {
              const key = cellKey(type.key, setting.key);
              const grade = gradeCell(data.cells, key)?.grades[0];
              if (!grade)
                return (
                  <Text key={setting.key} style={[styles.cell, styles.unavailable]}>
                    {"—"}
                  </Text>
                );
              const expanded = openKey === key;
              return (
                <TouchableOpacity
                  key={setting.key}
                  accessibilityRole="button"
                  accessibilityLabel={`${setting.label} ${type.spoken}, ${grade.grade}, ${grade.count} climbs`}
                  accessibilityState={{ expanded }}
                  onPress={() => setChosenKey(expanded ? null : key)}
                  style={[styles.gradeButton, expanded && styles.gradeButtonOpen]}
                >
                  <Text style={styles.gradeText}>
                    {grade.grade} {expanded ? "⌃" : "⌄"}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </View>

      <Text style={styles.legend}>— Insufficient evidence for a demonstrated grade</Text>

      {TYPES.flatMap((type) =>
        SETTINGS.map((setting) => {
          const key = cellKey(type.key, setting.key);
          const grade = gradeCell(data.cells, key)?.grades[0];
          if (!grade || openKey !== key) return null;
          const label = `${setting.label} ${type.spoken} · ${grade.grade} · ${gradeSystemLabel(grade.gradeSystem)}${
            grade.publishedLabel ? ` · ${grade.publishedLabel}` : ""
          }`;
          return (
            <View key={key} style={styles.evidence}>
              <Text style={styles.evidenceTitle}>{label}</Text>
              {grade.sends.map((send) => (
                <View
                  key={`${send.climbExternalId ?? send.logEntryId ?? ""}-${send.climbedOn}-${send.displayName ?? ""}`}
                  style={styles.send}
                >
                  <View style={styles.sendBody}>
                    {send.activityId ? (
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel={`Open ${send.displayName ?? "unnamed climb"} activity`}
                        onPress={() => router.push(`/activity/${send.activityId}`)}
                      >
                        <Text style={styles.sendName}>{send.displayName ?? "Unnamed climb"}</Text>
                      </TouchableOpacity>
                    ) : (
                      <Text style={styles.sendName}>{send.displayName ?? "Unnamed climb"}</Text>
                    )}
                    <View style={styles.sendMetaRow}>
                      <Text style={styles.sendMeta}>
                        {ascentStyleLabel(send, type.key === "top_rope")} ·
                      </Text>
                      {send.sourceUrl ? (
                        <TouchableOpacity
                          accessibilityRole="link"
                          accessibilityLabel={`Open ${send.provider} source`}
                          onPress={() => {
                            void Linking.openURL(send.sourceUrl ?? "").catch((cause: unknown) => {
                              captureException(cause, { context: "demonstrated-grade:source" });
                            });
                          }}
                        >
                          <Text style={styles.link}>{send.provider}</Text>
                        </TouchableOpacity>
                      ) : (
                        <Text style={styles.sendMeta}>{send.provider}</Text>
                      )}
                    </View>
                  </View>
                  <Text style={styles.sendDate}>{formatDateShort(send.climbedOn)}</Text>
                </View>
              ))}
            </View>
          );
        }),
      )}

      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="How 3:3:3 works"
        accessibilityState={{ expanded: methodOpen }}
        onPress={() => setMethodOpen((open) => !open)}
        style={styles.methodToggle}
      >
        <Text style={styles.methodSummary}>How 3:3:3 works</Text>
      </TouchableOpacity>
      {methodOpen ? (
        <Text style={styles.methodBody}>
          Dofek’s adaptation of IRCRA 3:3:3 counts any confirmed free send, including an onsight,
          flash, redpoint, or send with an unspecified ascent style. Each climb counts once. Top
          rope includes climbs recorded as Follow.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 8 },
  heading: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 8,
  },
  title: { color: colors.text, fontSize: 15, fontWeight: "700" },
  window: { color: colors.textTertiary, fontSize: 11, fontVariant: ["tabular-nums"] },
  explanation: { color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
  qualifier: { color: colors.textTertiary, fontSize: 11 },
  errorText: { color: "#f87171", fontSize: 12, textAlign: "center", paddingVertical: 8 },
  state: { color: colors.textTertiary, fontSize: 13, textAlign: "center", paddingVertical: 12 },
  matrix: { gap: 2 },
  row: { flexDirection: "row", alignItems: "center", minHeight: 36 },
  cell: { flex: 1, fontSize: 12 },
  rowLabel: { color: colors.textSecondary },
  columnLabel: { color: colors.textTertiary, textAlign: "center", fontWeight: "600" },
  unavailable: { color: colors.textTertiary, textAlign: "center" },
  gradeButton: {
    alignItems: "center",
    borderRadius: 8,
    flex: 1,
    justifyContent: "center",
    minHeight: 36,
    paddingHorizontal: 2,
  },
  gradeButtonOpen: { backgroundColor: colors.surfaceSecondary },
  gradeText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  legend: { color: colors.textTertiary, fontSize: 11 },
  evidence: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 10,
    gap: 6,
    padding: 10,
  },
  evidenceTitle: { color: colors.text, fontSize: 13, fontWeight: "600" },
  send: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  sendBody: { flexShrink: 1, gap: 2 },
  sendName: { color: colors.text, fontSize: 13, fontWeight: "600" },
  sendMeta: { color: colors.textTertiary, fontSize: 11 },
  sendMetaRow: { alignItems: "center", flexDirection: "row", gap: 4 },
  link: { color: colors.accent },
  sendDate: { color: colors.textTertiary, fontSize: 11, fontVariant: ["tabular-nums"] },
  methodToggle: { minHeight: 36, justifyContent: "center" },
  methodSummary: { color: colors.textTertiary, fontSize: 12, fontWeight: "600" },
  methodBody: { color: colors.textTertiary, fontSize: 11, lineHeight: 16 },
});
