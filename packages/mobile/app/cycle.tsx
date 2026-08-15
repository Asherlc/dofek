import { CYCLE_TRACKING_SAFETY_NOTICE, PHASE_DISPLAY } from "@dofek/scoring/menstrual-cycle";
import { Stack, useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { getQueryErrorMessage, QueryStatePanel } from "../components/QueryStatePanel";
import { trpc } from "../lib/trpc";
import { colors, fontSize, fontWeight, radius, spacing } from "../theme";
import { rootStackScreenOptions } from "./_layout-options";

function sourceLabel(source: {
  providerId: string;
  sourceName: string | null;
  sourceBundle: string | null;
}): string {
  return source.sourceName ?? source.sourceBundle ?? source.providerId;
}

export default function CycleScreen() {
  const router = useRouter();
  const currentPhase = trpc.menstrualCycle.currentPhase.useQuery();
  const history = trpc.menstrualCycle.history.useQuery({ months: 6 });

  const openSettings = (tab: "data-sources" | "privacy-export") => {
    router.push({ pathname: "/settings", params: { tab } });
  };

  return (
    <>
      <Stack.Screen options={{ ...rootStackScreenOptions, title: "Cycle Tracking" }} />
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Read-only data</Text>
          <Text style={styles.bodyText}>
            Cycle records come from connected providers. To correct a date, update it in the source
            app and sync again.
          </Text>
          <View style={styles.actions}>
            <Pressable
              accessibilityLabel="Data sources"
              accessibilityRole="link"
              onPress={() => openSettings("data-sources")}
              style={styles.action}
            >
              <Text style={styles.actionText}>Data sources</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="Export all data"
              accessibilityRole="link"
              onPress={() => openSettings("privacy-export")}
              style={styles.action}
            >
              <Text style={styles.actionText}>Export all data</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="Delete account data"
              accessibilityRole="link"
              onPress={() => openSettings("privacy-export")}
              style={styles.action}
            >
              <Text style={styles.actionText}>Delete account data</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Current phase</Text>
          {currentPhase.data ? (
            currentPhase.data.phase && currentPhase.data.estimate ? (
              <View>
                <View style={styles.phaseRow}>
                  <View
                    accessible
                    accessibilityLabel="Current cycle day"
                    style={[
                      styles.phaseCircle,
                      { backgroundColor: PHASE_DISPLAY[currentPhase.data.phase].color },
                    ]}
                  >
                    <Text style={styles.phaseDay}>{currentPhase.data.dayOfCycle}</Text>
                  </View>
                  <View style={styles.phaseText}>
                    <Text style={styles.phaseLabel}>{currentPhase.data.estimate.phaseLabel}</Text>
                    <Text style={styles.detailText}>{currentPhase.data.estimate.cycleDayLabel}</Text>
                  </View>
                </View>
                <View style={styles.details}>
                  <Text style={styles.bodyText}>{currentPhase.data.estimate.dayBasisLabel}</Text>
                  <Text style={styles.bodyText}>{currentPhase.data.estimate.methodLabel}</Text>
                  <Text style={styles.bodyText}>{currentPhase.data.estimate.uncertaintyLabel}</Text>
                  <Text style={styles.bodyText}>{currentPhase.data.estimate.limitationLabel}</Text>
                </View>
              </View>
            ) : (
              <View style={styles.details}>
                <Text style={styles.bodyText}>{currentPhase.data.availability.label}</Text>
                {currentPhase.data.availability.status === "no-history" ? (
                  <Text style={styles.bodyText}>
                    HealthKit cannot reveal whether read access was denied. Review Apple Health
                    permissions and sync status in Data sources.
                  </Text>
                ) : null}
              </View>
            )
          ) : currentPhase.isLoading ? (
            <QueryStatePanel variant="loading" minHeight={96} />
          ) : currentPhase.error ? (
            <QueryStatePanel
              variant="error"
              message={getQueryErrorMessage(currentPhase.error)}
              minHeight={96}
            />
          ) : (
            <QueryStatePanel
              variant="empty"
              message="No readable provider cycle data yet."
              minHeight={96}
            />
          )}

          <View
            accessible
            accessibilityLabel={`Cycle tracking safety notice. ${CYCLE_TRACKING_SAFETY_NOTICE}`}
            style={styles.notice}
          >
            <Text style={styles.noticeTitle}>Tracking limitation</Text>
            <Text style={styles.bodyText}>{CYCLE_TRACKING_SAFETY_NOTICE}</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Provider cycle starts</Text>
          {history.data ? (
            history.data.length > 0 ? (
              [...history.data].reverse().map((start) => (
                <View
                  accessible
                  accessibilityLabel={`Cycle start ${start.startDate}`}
                  key={start.id}
                  style={styles.historyRow}
                >
                  <Text style={styles.historyDate}>{start.startDate}</Text>
                  <View style={styles.sources}>
                    {start.sources.map((source) => (
                      <Text
                        key={`${source.providerId}:${source.sourceBundle}:${source.sourceName}`}
                        style={styles.source}
                      >
                        {sourceLabel(source)}
                      </Text>
                    ))}
                  </View>
                </View>
              ))
            ) : (
              <QueryStatePanel
                variant="empty"
                message="No readable provider cycle starts in the past 6 months."
              />
            )
          ) : history.isLoading ? (
            <QueryStatePanel variant="loading" />
          ) : history.error ? (
            <QueryStatePanel variant="error" message={getQueryErrorMessage(history.error)} />
          ) : (
            <QueryStatePanel
              variant="empty"
              message="No readable provider cycle starts in the past 6 months."
            />
          )}
        </View>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { gap: spacing.md, padding: spacing.md, paddingBottom: spacing.xl },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    textTransform: "uppercase",
  },
  bodyText: { color: colors.textSecondary, fontSize: fontSize.sm, lineHeight: 20 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  action: {
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  actionText: { color: colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  phaseRow: { alignItems: "center", flexDirection: "row", gap: spacing.md },
  phaseCircle: {
    alignItems: "center",
    borderRadius: 32,
    height: 64,
    justifyContent: "center",
    width: 64,
  },
  phaseDay: { color: "#ffffff", fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  phaseText: { flex: 1, gap: spacing.xs },
  phaseLabel: { color: colors.text, fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  detailText: { color: colors.textSecondary, fontSize: fontSize.sm },
  details: { gap: spacing.xs, marginTop: spacing.sm },
  notice: {
    backgroundColor: colors.surfaceSecondary,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.xs,
    marginTop: spacing.sm,
    padding: spacing.sm,
  },
  noticeTitle: { color: colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  historyRow: { borderBottomColor: colors.border, borderBottomWidth: 1, gap: spacing.xs, paddingVertical: spacing.sm },
  historyDate: { color: colors.text, fontSize: fontSize.base, fontWeight: fontWeight.semibold },
  sources: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  source: {
    borderColor: colors.border,
    borderRadius: radius.full,
    borderWidth: 1,
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
});
