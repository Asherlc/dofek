import { formatDateYmd } from "@dofek/format/format";
import { CYCLE_TRACKING_SAFETY_NOTICE, PHASE_DISPLAY } from "@dofek/scoring/menstrual-cycle";
import DateTimePicker from "@react-native-community/datetimepicker";
import { Stack } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { getQueryErrorMessage, QueryStatePanel } from "../components/QueryStatePanel";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { colors, fontSize, fontWeight, radius, spacing } from "../theme";
import { rootStackScreenOptions } from "./_layout-options";

function localDateFromYmd(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1, 12);
}

export default function CycleScreen() {
  const currentPhase = trpc.menstrualCycle.currentPhase.useQuery();
  const periodHistory = trpc.menstrualCycle.history.useQuery({ months: 6 });
  const [startDate, setStartDate] = useState(formatDateYmd());
  const utils = trpc.useUtils();
  const logMutation = trpc.menstrualCycle.logPeriod.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.menstrualCycle.currentPhase.invalidate(),
        utils.menstrualCycle.history.invalidate(),
      ]);
    },
    onError: (error) => {
      captureException(error, { source: "cycle-log-period" });
    },
  });

  return (
    <>
      <Stack.Screen options={{ ...rootStackScreenOptions, title: "Cycle Tracking" }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Current Phase</Text>
          {currentPhase.data !== undefined ? (
            currentPhase.data.phase && currentPhase.data.estimate ? (
              <View>
                <View style={styles.phaseRow}>
                  <View
                    style={[
                      styles.phaseCircle,
                      { backgroundColor: PHASE_DISPLAY[currentPhase.data.phase].color },
                    ]}
                  >
                    <Text style={styles.phaseDay}>{currentPhase.data.dayOfCycle}</Text>
                  </View>
                  <View style={styles.phaseText}>
                    <Text style={styles.phaseLabel}>{currentPhase.data.estimate.phaseLabel}</Text>
                    <Text style={styles.phaseDetail}>
                      {currentPhase.data.estimate.cycleDayLabel}
                    </Text>
                  </View>
                </View>
                <View style={styles.estimateDetails}>
                  <Text style={styles.estimateDetail}>
                    {currentPhase.data.estimate.dayBasisLabel}
                  </Text>
                  <Text style={styles.estimateDetail}>
                    {currentPhase.data.estimate.methodLabel}
                  </Text>
                  <Text style={styles.estimateDetail}>
                    {currentPhase.data.estimate.uncertaintyLabel}
                  </Text>
                  <Text style={styles.estimateDetail}>
                    {currentPhase.data.estimate.limitationLabel}
                  </Text>
                </View>
              </View>
            ) : (
              <Text style={styles.emptyText}>
                No active cycle detected. Log a period start to begin tracking.
              </Text>
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
              message="No active cycle detected. Log a period start to begin tracking."
              minHeight={96}
            />
          )}
          {currentPhase.data !== undefined && currentPhase.error ? (
            <QueryStatePanel
              variant="error"
              message={getQueryErrorMessage(currentPhase.error)}
              minHeight={72}
            />
          ) : null}
          <View
            accessible
            accessibilityLabel={`Cycle tracking safety notice. ${CYCLE_TRACKING_SAFETY_NOTICE}`}
            style={styles.safetyNotice}
          >
            <Text style={styles.safetyNoticeTitle}>Tracking limitation</Text>
            <Text style={styles.safetyNoticeText}>{CYCLE_TRACKING_SAFETY_NOTICE}</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Log Period Start</Text>
          <View style={styles.logRow}>
            <DateTimePicker
              accessibilityLabel="Period start date"
              display="compact"
              maximumDate={new Date()}
              mode="date"
              onChange={(_event, selectedDate) => {
                if (selectedDate) setStartDate(formatDateYmd(selectedDate));
              }}
              value={localDateFromYmd(startDate)}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={logMutation.error ? "Retry" : "Log Period"}
              accessibilityState={{ busy: logMutation.isPending }}
              disabled={logMutation.isPending}
              onPress={() => logMutation.mutate({ startDate })}
              style={[styles.logButton, logMutation.isPending && styles.buttonDisabled]}
            >
              <Text style={styles.logButtonText}>
                {logMutation.isPending ? "Saving..." : logMutation.error ? "Retry" : "Log Period"}
              </Text>
            </Pressable>
          </View>
          {logMutation.error ? (
            <QueryStatePanel
              variant="error"
              message={getQueryErrorMessage(logMutation.error)}
              minHeight={72}
              style={styles.mutationError}
            />
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Period History</Text>
          {periodHistory.data !== undefined ? (
            periodHistory.data.length > 0 ? (
              [...periodHistory.data].reverse().map((period) => (
                <View key={period.id} style={styles.historyRow}>
                  <View style={styles.historyDates}>
                    <Text style={styles.historyStart}>{period.startDate}</Text>
                    {period.endDate ? (
                      <Text style={styles.historyEnd}> to {period.endDate}</Text>
                    ) : null}
                  </View>
                  {period.durationLabel ? (
                    <Text style={styles.duration}>{period.durationLabel}</Text>
                  ) : null}
                </View>
              ))
            ) : (
              <QueryStatePanel variant="empty" message="No periods logged yet." minHeight={96} />
            )
          ) : periodHistory.isLoading ? (
            <QueryStatePanel variant="loading" minHeight={96} />
          ) : periodHistory.error ? (
            <QueryStatePanel
              variant="error"
              message={getQueryErrorMessage(periodHistory.error)}
              minHeight={96}
            />
          ) : (
            <QueryStatePanel variant="empty" message="No periods logged yet." minHeight={96} />
          )}
          {periodHistory.data !== undefined && periodHistory.error ? (
            <QueryStatePanel
              variant="error"
              message={getQueryErrorMessage(periodHistory.error)}
              minHeight={72}
            />
          ) : null}
        </View>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: 16,
    paddingBottom: 40,
    gap: 16,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  phaseRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  phaseText: {
    flex: 1,
  },
  phaseCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  phaseDay: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "700",
  },
  phaseLabel: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "600",
  },
  phaseDetail: {
    color: colors.textTertiary,
    fontSize: 12,
    marginTop: 2,
  },
  estimateDetails: {
    gap: spacing.xs,
    marginTop: spacing.md,
  },
  estimateDetail: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  safetyNotice: {
    backgroundColor: colors.surfaceSecondary,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    marginTop: spacing.sm,
    padding: spacing.md,
  },
  safetyNoticeTitle: {
    color: colors.text,
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
  },
  safetyNoticeText: {
    color: colors.textSecondary,
    fontSize: fontSize.base,
    lineHeight: 20,
  },
  emptyText: {
    color: colors.textTertiary,
    fontSize: 14,
  },
  logRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  logButton: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  logButtonText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "600",
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  mutationError: {
    marginTop: 12,
  },
  historyRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceSecondary,
  },
  historyDates: {
    flexDirection: "row",
    flexShrink: 1,
  },
  historyStart: {
    color: colors.text,
    fontSize: 14,
  },
  historyEnd: {
    color: colors.textTertiary,
    fontSize: 14,
  },
  duration: {
    color: colors.textSecondary,
    fontSize: 12,
  },
});
