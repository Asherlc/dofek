import {
  formatDateMedium,
  formatDateShort,
  formatDurationSeconds,
  formatNumber,
} from "@dofek/format/format";
import { formatMeasurementText, type UnitConverter } from "@dofek/format/units";
import type { AppRouterOutputs } from "dofek-server/router";
import { useRouter } from "expo-router";
import { type ReactNode, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";
import { ProviderRecordDetail } from "./providers/provider-record-detail";
import { QueryStatePanel } from "./QueryStatePanel";

type Profile = AppRouterOutputs["cycling"]["powerProfile"];
type Weight = Profile["threshold"]["weight"];
type WeightRecord = { providerId: string; recordId: string };

const durationLabels = { 5: "5 seconds", 60: "1 minute", 300: "5 minutes" } as const;

function ProfileRow({
  label,
  detail,
  date,
  watts,
  wattsPerKg,
  missingMessage,
  children,
}: {
  label: string;
  detail?: string | null;
  date?: string | null;
  watts: number | null;
  wattsPerKg: number | null;
  missingMessage?: string;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const content = (
    <>
      <View style={styles.rowDetail}>
        <Text style={styles.strong}>{label}</Text>
        <Text style={styles.muted}>{watts === null ? missingMessage : detail}</Text>
        {date && <Text style={styles.muted}>{date}</Text>}
      </View>
      <View style={styles.metrics}>
        {wattsPerKg !== null && (
          <Text style={styles.strong}>{formatNumber(wattsPerKg, 2)} W/kg</Text>
        )}
        {watts !== null && <Text style={styles.muted}>{formatNumber(watts, 0)} W</Text>}
      </View>
    </>
  );

  return (
    <View style={styles.row}>
      {watts === null ? (
        <View style={styles.rowSummary}>{content}</View>
      ) : (
        <Pressable
          style={styles.rowSummary}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(!expanded)}
        >
          {content}
          <Text style={styles.muted} accessible={false}>
            {expanded ? "▴" : "▾"}
          </Text>
        </Pressable>
      )}
      {expanded && <View style={styles.evidence}>{children}</View>}
    </View>
  );
}

function BodyWeight({
  weight,
  units,
  openRecord,
}: {
  weight: Weight;
  units: UnitConverter;
  openRecord: (record: WeightRecord) => void;
}) {
  if (weight === null) return null;
  if (weight.value_kg === null) return <Text style={styles.muted}>{weight.reason}</Text>;

  return (
    <View>
      <Text style={styles.muted}>Body weight</Text>
      {weight.kind === "interpolated" && (
        <Text style={styles.text}>
          {formatMeasurementText(units.formatWeight(weight.value_kg))} interpolated
        </Text>
      )}
      {weight.sources.map((source) => {
        const label = `${formatMeasurementText(units.formatWeight(source.value_kg))} · ${formatDateShort(source.date)}`;
        const recordId = source.record_id;
        return recordId ? (
          <Pressable
            key={recordId}
            accessibilityRole="link"
            style={styles.linkTarget}
            onPress={() => openRecord({ providerId: source.provider, recordId })}
          >
            <Text style={styles.linkText}>{label}</Text>
          </Pressable>
        ) : (
          <Text key={`${source.provider}:${source.recorded_at}`} style={styles.text}>
            {label}
          </Text>
        );
      })}
    </View>
  );
}

export function CyclingPowerProfile({
  profile,
  units,
  loading = false,
  error,
}: {
  profile?: Profile;
  units: UnitConverter;
  loading?: boolean;
  error?: { message: string } | null;
}) {
  const router = useRouter();
  const [record, setRecord] = useState<WeightRecord | null>(null);

  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.strong}>
        Cycling power profile
      </Text>
      {error && <QueryStatePanel variant="error" message={error.message} />}
      {loading && !profile && <QueryStatePanel variant="loading" />}
      {profile && (
        <>
          <Text style={styles.muted}>
            {profile.range.start_date ? formatDateMedium(profile.range.start_date) : "All time"} –{" "}
            {formatDateMedium(profile.range.end_date)}
          </Text>
          <Text style={styles.muted}>Maximal test status unverified</Text>
          {profile.efforts.map(({ duration_seconds, effort }) => (
            <ProfileRow
              key={duration_seconds}
              label={durationLabels[duration_seconds]}
              detail={effort?.activity_name ?? "Cycling activity"}
              date={effort ? formatDateShort(effort.date) : null}
              watts={effort?.watts ?? null}
              wattsPerKg={effort?.watts_per_kg ?? null}
              missingMessage="No recorded effort"
            >
              {effort && (
                <>
                  {effort.start_offset_seconds !== null && effort.end_offset_seconds !== null && (
                    <Text style={styles.text}>
                      {formatDurationSeconds(effort.start_offset_seconds, { precision: "second" })}{" "}
                      – {formatDurationSeconds(effort.end_offset_seconds, { precision: "second" })}{" "}
                      elapsed
                    </Text>
                  )}
                  <Pressable
                    accessibilityRole="link"
                    style={styles.linkTarget}
                    onPress={() =>
                      router.push({
                        pathname: "/activity/[id]",
                        params: { id: effort.activity_id },
                      })
                    }
                  >
                    <Text style={styles.linkText}>View activity</Text>
                  </Pressable>
                  <BodyWeight weight={effort.weight} units={units} openRecord={setRecord} />
                </>
              )}
            </ProfileRow>
          ))}
          <ProfileRow
            label="Threshold (FTP)"
            detail="Dofek cycling settings"
            date={
              profile.threshold.effective_from
                ? `Effective ${formatDateMedium(profile.threshold.effective_from)}`
                : null
            }
            watts={profile.threshold.watts}
            wattsPerKg={profile.threshold.watts_per_kg}
            missingMessage="No configured FTP"
          >
            <BodyWeight weight={profile.threshold.weight} units={units} openRecord={setRecord} />
          </ProfileRow>
        </>
      )}
      {record && (
        <ProviderRecordDetail
          input={{ ...record, dataType: "bodyMeasurements" }}
          onClose={() => setRecord(null)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.xs,
  },
  row: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  rowSummary: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  rowDetail: { flex: 1, gap: spacing.xs },
  metrics: { alignItems: "flex-end" },
  evidence: { paddingHorizontal: spacing.sm, paddingBottom: spacing.sm, gap: spacing.xs },
  strong: { color: colors.text, fontWeight: "600" },
  text: { color: colors.text },
  muted: { color: colors.textSecondary, fontSize: 12 },
  linkTarget: { minHeight: 44, justifyContent: "center" },
  linkText: { color: colors.text, textDecorationLine: "underline" },
});
