import {
  cyclingDurabilityDurations,
  cyclingDurabilityEmpty,
  cyclingDurabilityIntro,
  cyclingDurabilityNoLateEffort,
  cyclingDurabilityTitle,
  cyclingDurabilityWorkHelp,
  cyclingDurabilityWorkLevels,
  formatDurabilityOffset,
  formatDurabilityPower,
  formatDurabilityRange,
  formatDurabilityWeight,
  formatDurabilityWork,
} from "@dofek/format/cycling-durability";
import { formatDateMedium, formatNumber } from "@dofek/format/format";
import { formatMeasurementText, type UnitConverter } from "@dofek/format/units";
import { fontSize, fontWeight } from "@dofek/scoring/tokens";
import type {
  CyclingDurabilityEffort,
  CyclingDurabilityResult,
  CyclingDurabilitySelection,
} from "dofek-server/types";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Rect } from "react-native-svg";
import { trpc } from "../lib/trpc";
import { colors, radius, spacing } from "../theme";
import { getQueryErrorMessage, QueryStatePanel } from "./QueryStatePanel";

export function CyclingDurability({
  days,
  enabled,
  units,
}: {
  days: number | null;
  enabled: boolean;
  units: UnitConverter;
}) {
  const [selection, setSelection] = useState<CyclingDurabilitySelection>({
    durationSeconds: 300,
    minimumWorkKilojoulesPerKg: 30,
  });
  const query = trpc.cycling.durability.useQuery(
    { days, ...selection },
    { enabled, placeholderData: (previous) => previous },
  );
  return (
    <CyclingDurabilityPanel
      data={query.data}
      error={query.error}
      loading={query.isLoading}
      units={units}
      selection={selection}
      onChange={setSelection}
    />
  );
}

export function CyclingDurabilityPanel({
  data,
  error,
  loading,
  units,
  selection,
  onChange,
}: {
  data?: CyclingDurabilityResult;
  error?: unknown;
  loading?: boolean;
  units: UnitConverter;
  selection: CyclingDurabilitySelection;
  onChange: (selection: CyclingDurabilitySelection) => void;
}) {
  const [showControls, setShowControls] = useState(false);
  const [showEfforts, setShowEfforts] = useState(false);
  const referenceWeight =
    data?.presentation.absoluteWorkCutoffKilojoules == null
      ? undefined
      : data.baseline?.weight.value_kg;

  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>
        {cyclingDurabilityTitle}
      </Text>
      {data ? (
        <Text style={styles.muted}>
          {formatDurabilityRange(data.range.startDate, data.range.endDate)}
        </Text>
      ) : null}
      <Text style={styles.body}>{cyclingDurabilityIntro}</Text>
      {data ? <DurabilityResult data={data} /> : null}
      {error ? (
        <QueryStatePanel variant="error" message={getQueryErrorMessage(error)} />
      ) : loading && !data ? (
        <QueryStatePanel variant="loading" />
      ) : null}
      <Text style={styles.muted}>{cyclingDurabilityWorkHelp}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: showControls }}
        onPress={() => setShowControls(!showControls)}
        style={styles.disclosure}
      >
        <Text style={styles.label}>Change comparison</Text>
      </Pressable>
      {showControls ? (
        <View style={styles.group}>
          <Text style={styles.label}>Effort length</Text>
          <View
            style={styles.choices}
            accessibilityRole="radiogroup"
            accessibilityLabel="Effort length"
          >
            {cyclingDurabilityDurations.map(({ value, label }) => (
              <Choice
                key={value}
                label={label}
                checked={value === selection.durationSeconds}
                onPress={() => onChange({ ...selection, durationSeconds: value })}
              />
            ))}
          </View>
          <Text style={styles.label}>Pedaling before the effort</Text>
          <View
            style={styles.choices}
            accessibilityRole="radiogroup"
            accessibilityLabel="Pedaling before the effort"
          >
            {cyclingDurabilityWorkLevels.map((value) => (
              <Choice
                key={value}
                label={`At least ${formatDurabilityWork(value * (referenceWeight ?? 1), referenceWeight == null)}`}
                checked={value === selection.minimumWorkKilojoulesPerKg}
                onPress={() => onChange({ ...selection, minimumWorkKilojoulesPerKg: value })}
              />
            ))}
          </View>
        </View>
      ) : null}
      {data?.baseline ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showEfforts }}
            onPress={() => setShowEfforts(!showEfforts)}
            style={styles.disclosure}
          >
            <Text style={styles.label}>See the rides behind these numbers</Text>
          </Pressable>
          {showEfforts ? (
            <View style={styles.group}>
              <Text style={styles.muted}>This comparison uses outdoor rides.</Text>
              {data.sameEffort ? (
                <Text style={styles.body}>Both values came from the same effort.</Text>
              ) : null}
              <EffortDetails label="Best at any point" effort={data.baseline} units={units} />
              {data.afterWork && !data.sameEffort ? (
                <EffortDetails
                  label="Best after sustained riding"
                  effort={data.afterWork}
                  units={units}
                />
              ) : null}
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function Choice({
  label,
  checked,
  onPress,
}: {
  label: string;
  checked: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked }}
      onPress={onPress}
      style={[styles.choice, checked && styles.selectedChoice]}
    >
      <Text style={styles.body}>{label}</Text>
    </Pressable>
  );
}

function DurabilityResult({ data }: { data: CyclingDurabilityResult }) {
  const { baseline, afterWork, presentation, selection } = data;
  if (!baseline) return <QueryStatePanel variant="empty" message={cyclingDurabilityEmpty} />;
  const { unit, difference, absoluteWorkCutoffKilojoules } = presentation;
  const cutoff =
    absoluteWorkCutoffKilojoules == null
      ? `${formatDurabilityWork(selection.minimumWorkKilojoulesPerKg, true)} of body weight`
      : `${formatDurabilityWork(absoluteWorkCutoffKilojoules)} of pedaling`;
  const duration = cyclingDurabilityDurations.find(
    ({ value }) => value === selection.durationSeconds,
  );
  const baselineValue = unit === "watts" ? baseline.watts : baseline.wattsPerKg;
  const afterValue = afterWork && (unit === "watts" ? afterWork.watts : afterWork.wattsPerKg);

  return (
    <View style={styles.group} accessibilityLiveRegion="polite">
      <Text style={styles.headline}>
        {afterWork
          ? difference === 0
            ? "Same power"
            : `${formatDurabilityPower(difference, unit)} lower`
          : "No effort after this work"}
      </Text>
      <Text style={styles.muted}>
        Best {duration?.adjective} power after at least {cutoff}
      </Text>
      <PowerBar
        label="Best at any point in a ride"
        unit={unit}
        value={baselineValue}
        total={baselineValue}
      />
      {afterValue == null ? (
        <Text style={styles.body}>{cyclingDurabilityNoLateEffort}</Text>
      ) : (
        <PowerBar
          label={`Best after at least ${cutoff}`}
          value={afterValue}
          total={baselineValue}
          unit={unit}
        />
      )}
    </View>
  );
}

function PowerBar({
  label,
  value,
  total,
  unit,
}: {
  label: string;
  value: number;
  total: number;
  unit: CyclingDurabilityResult["presentation"]["unit"];
}) {
  const percent = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <View style={styles.bar}>
      <View style={styles.barLabels}>
        <Text style={[styles.body, styles.barLabel]}>{label}</Text>
        <Text style={styles.label}>{formatDurabilityPower(value, unit)}</Text>
      </View>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Svg height={6} width="100%">
          <Rect width="100%" height={6} rx={3} fill={colors.border} />
          <Rect width={`${percent}%`} height={6} rx={3} fill={colors.accent} />
        </Svg>
      </View>
    </View>
  );
}

function EffortDetails({
  label,
  effort,
  units,
}: {
  label: string;
  effort: CyclingDurabilityEffort;
  units: UnitConverter;
}) {
  const { weight, power, coverage } = effort;
  return (
    <View style={styles.bar}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.body}>
        {effort.activityName ?? "Cycling ride"} · {formatDateMedium(effort.date)}
      </Text>
      <Text style={styles.body}>
        {formatDurabilityOffset(effort.elapsedStartSeconds)}–
        {formatDurabilityOffset(effort.elapsedEndSeconds)} into the recording
      </Text>
      <Text style={styles.body}>
        {formatDurabilityPower(effort.watts, "watts")} ·{" "}
        {formatDurabilityPower(effort.wattsPerKg, "w_per_kg")}
      </Text>
      <Text style={styles.body}>
        {formatDurabilityWork(effort.workKilojoules)} before the effort (
        {formatNumber(effort.workKilojoulesPerKg, 1)} kJ/kg)
      </Text>
      <Text style={styles.body}>
        {formatDurabilityWeight(
          weight.kind,
          formatMeasurementText(units.formatWeight(weight.value_kg)),
        )}
      </Text>
      <Text style={styles.body}>
        Weight readings from{" "}
        {weight.sources.map(({ date }) => formatDateMedium(date)).join(" and ")}
      </Text>
      <Text style={styles.body}>
        Power meter data from {power.provider}
        {power.deviceId ? ` · ${power.deviceId}` : ""}
      </Text>
      {power.provenance === "meter_flag" ? (
        <Text style={styles.body}>The source confirms this ride used a power meter.</Text>
      ) : null}
      <Text style={styles.muted}>
        {coverage.observedSamples} readings during the effort · Typically{" "}
        {formatNumber(coverage.medianSampleIntervalSeconds, 1)} seconds apart
      </Text>
      <Text style={styles.muted}>Complete power data from ride start through the effort</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    padding: spacing.md,
    backgroundColor: colors.surface,
    gap: spacing.sm,
  },
  title: { color: colors.text, fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  headline: { color: colors.text, fontSize: fontSize.xl, fontWeight: fontWeight.bold },
  body: { color: colors.text, fontSize: fontSize.sm },
  muted: { color: colors.textSecondary, fontSize: fontSize.sm },
  label: { color: colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  disclosure: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    minHeight: 44,
    justifyContent: "center",
  },
  group: { gap: spacing.sm },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  choice: {
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    minHeight: 44,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  selectedChoice: { borderColor: colors.accent },
  bar: { gap: spacing.xs },
  barLabels: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: spacing.sm,
  },
  barLabel: { flex: 1 },
});
