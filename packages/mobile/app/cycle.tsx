import { formatDateYmd } from "@dofek/format/format";
import { CYCLE_TRACKING_SAFETY_NOTICE, PHASE_DISPLAY } from "@dofek/scoring/menstrual-cycle";
import DateTimePicker from "@react-native-community/datetimepicker";
import { Stack, useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { getQueryErrorMessage, QueryStatePanel } from "../components/QueryStatePanel";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { colors, fontSize, fontWeight, radius, spacing } from "../theme";
import { rootStackScreenOptions } from "./_layout-options";

function localDateFromYmd(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1, 12);
}

interface PeriodEditDraft {
  id: string;
  startDate: string;
  endDate: string | null;
  notes: string;
}

export default function CycleScreen() {
  const router = useRouter();
  const scrollViewRef = useRef<ScrollView>(null);
  const currentPhase = trpc.menstrualCycle.currentPhase.useQuery();
  const periodHistory = trpc.menstrualCycle.history.useQuery({ months: 6 });
  const [startDate, setStartDate] = useState(formatDateYmd());
  const [editDraft, setEditDraft] = useState<PeriodEditDraft | null>(null);
  const [deleteConfirmationId, setDeleteConfirmationId] = useState<string | null>(null);
  const [historyOffset, setHistoryOffset] = useState<number | null>(null);
  const maximumPeriodDate = localDateFromYmd(formatDateYmd());
  const utils = trpc.useUtils();
  const invalidateCycleData = async () => {
    await Promise.all([
      utils.menstrualCycle.currentPhase.invalidate(),
      utils.menstrualCycle.history.invalidate(),
    ]);
  };
  const logMutation = trpc.menstrualCycle.logPeriod.useMutation({
    onError: (error) => {
      captureException(error, { source: "cycle-log-period" });
    },
    onSettled: invalidateCycleData,
  });
  const updateMutation = trpc.menstrualCycle.updatePeriod.useMutation({
    onSuccess: () => {
      setEditDraft(null);
    },
    onError: (error) => {
      captureException(error, { source: "cycle-update-period" });
    },
    onSettled: invalidateCycleData,
  });
  const deleteMutation = trpc.menstrualCycle.deletePeriod.useMutation({
    onSuccess: () => {
      setDeleteConfirmationId(null);
    },
    onError: (error) => {
      captureException(error, { source: "cycle-delete-period" });
    },
    onSettled: invalidateCycleData,
  });

  return (
    <>
      <Stack.Screen options={{ ...rootStackScreenOptions, title: "Cycle Tracking" }} />
      <ScrollView
        ref={scrollViewRef}
        style={styles.container}
        contentContainerStyle={styles.content}
      >
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Privacy & data</Text>
          <Text style={styles.privacyText}>
            Cycle entries and notes are sensitive health data. Review what is stored here; export
            all health data or permanently delete all account data from Account settings.
          </Text>
          <View style={styles.privacyActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Review cycle history"
              onPress={() =>
                scrollViewRef.current?.scrollTo({ animated: true, y: historyOffset ?? 0 })
              }
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>Review cycle history</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Export all data"
              onPress={() => router.push({ pathname: "/settings", params: { tab: "account" } })}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>Export all data</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Delete all data"
              onPress={() => router.push({ pathname: "/settings", params: { tab: "account" } })}
              style={styles.deleteButton}
            >
              <Text style={styles.deleteButtonText}>Delete all data</Text>
            </Pressable>
          </View>
        </View>

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
              <Text style={styles.emptyText}>{currentPhase.data.availability.label}</Text>
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
              maximumDate={maximumPeriodDate}
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

        <View
          onLayout={(event) => setHistoryOffset(event.nativeEvent.layout.y)}
          style={styles.card}
        >
          <Text style={styles.sectionTitle}>Period History</Text>
          {periodHistory.data !== undefined ? (
            periodHistory.data.length > 0 ? (
              [...periodHistory.data].reverse().map((period) => (
                <View key={period.id} style={styles.historyRow}>
                  {editDraft?.id === period.id ? (
                    <View style={styles.editForm}>
                      <View style={styles.editField}>
                        <Text style={styles.editLabel}>Start date</Text>
                        <DateTimePicker
                          accessibilityLabel="Corrected period start date"
                          display="compact"
                          maximumDate={maximumPeriodDate}
                          mode="date"
                          onChange={(_event, selectedDate) => {
                            if (selectedDate) {
                              setEditDraft({
                                ...editDraft,
                                startDate: formatDateYmd(selectedDate),
                              });
                            }
                          }}
                          value={localDateFromYmd(editDraft.startDate)}
                        />
                      </View>
                      <View style={styles.editField}>
                        <Text style={styles.editLabel}>End date (optional)</Text>
                        {editDraft.endDate ? (
                          <View style={styles.editActionRow}>
                            <DateTimePicker
                              accessibilityLabel="Corrected period end date"
                              display="compact"
                              maximumDate={maximumPeriodDate}
                              minimumDate={localDateFromYmd(editDraft.startDate)}
                              mode="date"
                              onChange={(_event, selectedDate) => {
                                if (selectedDate) {
                                  setEditDraft({
                                    ...editDraft,
                                    endDate: formatDateYmd(selectedDate),
                                  });
                                }
                              }}
                              value={localDateFromYmd(editDraft.endDate)}
                            />
                            <Pressable
                              accessibilityLabel="Clear period end date"
                              accessibilityRole="button"
                              onPress={() => setEditDraft({ ...editDraft, endDate: null })}
                              style={styles.secondaryButton}
                            >
                              <Text style={styles.secondaryButtonText}>Clear</Text>
                            </Pressable>
                          </View>
                        ) : (
                          <Pressable
                            accessibilityLabel="Add period end date"
                            accessibilityRole="button"
                            onPress={() =>
                              setEditDraft({ ...editDraft, endDate: editDraft.startDate })
                            }
                            style={styles.secondaryButton}
                          >
                            <Text style={styles.secondaryButtonText}>Add end date</Text>
                          </Pressable>
                        )}
                      </View>
                      <View style={styles.editField}>
                        <Text style={styles.editLabel}>Notes (optional)</Text>
                        <TextInput
                          aria-label="Period notes"
                          onChangeText={(notes) => setEditDraft({ ...editDraft, notes })}
                          style={styles.notesInput}
                          value={editDraft.notes}
                        />
                      </View>
                      <View style={styles.editActionRow}>
                        <Pressable
                          accessibilityLabel={
                            updateMutation.error ? "Retry period changes" : "Save period changes"
                          }
                          accessibilityRole="button"
                          accessibilityState={{ busy: updateMutation.isPending }}
                          disabled={updateMutation.isPending}
                          onPress={() =>
                            updateMutation.mutate({
                              id: editDraft.id,
                              startDate: editDraft.startDate,
                              endDate: editDraft.endDate,
                              notes: editDraft.notes.trim() || null,
                            })
                          }
                          style={[
                            styles.logButton,
                            updateMutation.isPending && styles.buttonDisabled,
                          ]}
                        >
                          <Text style={styles.logButtonText}>
                            {updateMutation.isPending
                              ? "Saving..."
                              : updateMutation.error
                                ? "Retry"
                                : "Save"}
                          </Text>
                        </Pressable>
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => {
                            updateMutation.reset();
                            setEditDraft(null);
                          }}
                          style={styles.secondaryButton}
                        >
                          <Text style={styles.secondaryButtonText}>Cancel</Text>
                        </Pressable>
                      </View>
                      {updateMutation.error ? (
                        <QueryStatePanel
                          variant="error"
                          message={getQueryErrorMessage(updateMutation.error)}
                          minHeight={72}
                        />
                      ) : null}
                    </View>
                  ) : (
                    <>
                      <View style={styles.historySummary}>
                        <View style={styles.historyText}>
                          <View style={styles.historyDates}>
                            <Text style={styles.historyStart}>{period.startDate}</Text>
                            {period.endDate ? (
                              <Text style={styles.historyEnd}> to {period.endDate}</Text>
                            ) : null}
                          </View>
                          {period.notes ? (
                            <Text style={styles.historyNotes}>{period.notes}</Text>
                          ) : null}
                        </View>
                        {period.durationLabel ? (
                          <Text style={styles.duration}>{period.durationLabel}</Text>
                        ) : null}
                      </View>
                      <View style={styles.historyActions}>
                        <Pressable
                          accessibilityLabel={`Edit period starting ${period.startDate}`}
                          accessibilityRole="button"
                          onPress={() => {
                            updateMutation.reset();
                            deleteMutation.reset();
                            setDeleteConfirmationId(null);
                            setEditDraft({
                              id: period.id,
                              startDate: period.startDate,
                              endDate: period.endDate,
                              notes: period.notes ?? "",
                            });
                          }}
                          style={styles.secondaryButton}
                        >
                          <Text style={styles.secondaryButtonText}>Edit</Text>
                        </Pressable>
                        {deleteConfirmationId === period.id ? (
                          <>
                            <Pressable
                              accessibilityLabel="Confirm delete period"
                              accessibilityRole="button"
                              accessibilityState={{ busy: deleteMutation.isPending }}
                              disabled={deleteMutation.isPending}
                              onPress={() => deleteMutation.mutate({ id: period.id })}
                              style={[
                                styles.deleteConfirmButton,
                                deleteMutation.isPending && styles.buttonDisabled,
                              ]}
                            >
                              <Text style={styles.deleteConfirmButtonText}>
                                {deleteMutation.isPending ? "Deleting..." : "Confirm delete"}
                              </Text>
                            </Pressable>
                            <Pressable
                              accessibilityRole="button"
                              onPress={() => {
                                deleteMutation.reset();
                                setDeleteConfirmationId(null);
                              }}
                              style={styles.secondaryButton}
                            >
                              <Text style={styles.secondaryButtonText}>Cancel</Text>
                            </Pressable>
                          </>
                        ) : (
                          <Pressable
                            accessibilityLabel={`Delete period starting ${period.startDate}`}
                            accessibilityRole="button"
                            onPress={() => {
                              updateMutation.reset();
                              deleteMutation.reset();
                              setEditDraft(null);
                              setDeleteConfirmationId(period.id);
                            }}
                            style={styles.deleteButton}
                          >
                            <Text style={styles.deleteButtonText}>Delete</Text>
                          </Pressable>
                        )}
                      </View>
                      {deleteConfirmationId === period.id && deleteMutation.error ? (
                        <QueryStatePanel
                          variant="error"
                          message={getQueryErrorMessage(deleteMutation.error)}
                          minHeight={72}
                        />
                      ) : null}
                    </>
                  )}
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
  privacyText: {
    color: colors.textSecondary,
    fontSize: fontSize.base,
    lineHeight: 20,
  },
  privacyActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.md,
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
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceSecondary,
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  historySummary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  historyText: {
    flex: 1,
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
  historyNotes: {
    color: colors.textTertiary,
    fontSize: fontSize.sm,
    marginTop: spacing.xs,
  },
  historyActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    justifyContent: "flex-end",
  },
  editForm: {
    gap: spacing.md,
  },
  editField: {
    gap: spacing.xs,
  },
  editLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  editActionRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  notesInput: {
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.text,
    fontSize: fontSize.base,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  secondaryButton: {
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  secondaryButtonText: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  deleteButton: {
    borderColor: colors.danger,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  deleteButtonText: {
    color: colors.danger,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  deleteConfirmButton: {
    backgroundColor: colors.danger,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  deleteConfirmButtonText: {
    color: colors.textInverse,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
});
