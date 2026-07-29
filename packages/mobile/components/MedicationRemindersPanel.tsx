import { formatDateTime } from "@dofek/format/format";
import { formatDoseStatus, medicationDoseEventSchema } from "@dofek/format/medication-dose-events";
import {
  findLatestDoseLoggingState,
  MEDICATION_REMINDERS_SETTINGS_KEY,
  type MedicationReminder,
  medicationReminderSchema,
  parseMedicationReminders,
} from "@dofek/format/medication-reminders";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { z } from "zod";
import { createReminderId } from "../lib/create-reminder-id";
import { syncMedicationReminderNotifications } from "../lib/medication-reminder-notifications";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { colors, radius, spacing } from "../theme";
import { QueryStatePanel } from "./QueryStatePanel";

type MedicationRemindersQueryResult = {
  isLoading: boolean;
  error: { message: string } | null;
  data?: { key?: string; value?: unknown } | null;
};

type MedicationDoseEventsQueryResult = {
  isLoading: boolean;
  error: { message: string } | null;
  data?: { events?: unknown } | null;
};

export function MedicationRemindersPanel({
  focusedReminderId,
  remindersQueryResult,
  doseEventsQueryResult,
}: {
  focusedReminderId?: string | null;
  remindersQueryResult?: MedicationRemindersQueryResult;
  doseEventsQueryResult?: MedicationDoseEventsQueryResult;
}) {
  const internalReminders = trpc.settings.get.useQuery({
    key: MEDICATION_REMINDERS_SETTINGS_KEY,
  });
  const internalDoseEvents = trpc.medicationDoseEvents.list.useQuery({ limit: 50 });
  const setting = remindersQueryResult ?? internalReminders;
  const doseEvents = doseEventsQueryResult ?? internalDoseEvents;
  const setSettingMutation = trpc.settings.set.useMutation();
  const trpcUtils = trpc.useUtils();
  const [writeError, setWriteError] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftTime, setDraftTime] = useState("08:00");
  const lastReadError = useRef<unknown>(null);
  const lastSyncedSignature = useRef<string | null>(null);

  useEffect(() => {
    if (setting.error && lastReadError.current !== setting.error) {
      lastReadError.current = setting.error;
      captureException(setting.error, { context: "medication-reminders-read" });
    }
  }, [setting.error]);

  useEffect(() => {
    if (setting.isLoading || setting.error) return;

    let nextReminders: MedicationReminder[];
    try {
      nextReminders = parseMedicationReminders(setting.data?.value);
    } catch (error: unknown) {
      captureException(error, { context: "medication-reminders-sync-parse" });
      return;
    }

    const signature = JSON.stringify(nextReminders);
    if (lastSyncedSignature.current === signature) return;
    lastSyncedSignature.current = signature;
    void syncMedicationReminderNotifications(nextReminders).catch((error: unknown) => {
      captureException(error, { context: "medication-reminder-notifications" });
    });
  }, [setting.data?.value, setting.error, setting.isLoading]);

  if (setting.isLoading || doseEvents.isLoading) {
    return <QueryStatePanel variant="loading" minHeight={96} />;
  }

  if (setting.error) {
    return <QueryStatePanel variant="error" minHeight={96} message={setting.error.message} />;
  }

  if (doseEvents.error) {
    return <QueryStatePanel variant="error" minHeight={96} message={doseEvents.error.message} />;
  }

  let reminders: MedicationReminder[] = [];
  try {
    reminders = parseMedicationReminders(setting.data?.value);
  } catch (error) {
    captureException(error, { context: "medication-reminders-parse" });
    return (
      <QueryStatePanel
        variant="error"
        minHeight={96}
        message="Saved medication reminders are invalid. Reset them to continue."
      />
    );
  }

  const eventsParsed = z.array(medicationDoseEventSchema).safeParse(doseEvents.data?.events ?? []);
  const events = eventsParsed.success ? eventsParsed.data : [];

  const persistReminders = (nextReminders: MedicationReminder[]) => {
    const previousSetting = trpcUtils.settings.get.getData({
      key: MEDICATION_REMINDERS_SETTINGS_KEY,
    });
    trpcUtils.settings.get.setData(
      { key: MEDICATION_REMINDERS_SETTINGS_KEY },
      { key: MEDICATION_REMINDERS_SETTINGS_KEY, value: nextReminders },
    );
    setWriteError(null);
    setSettingMutation.mutate(
      { key: MEDICATION_REMINDERS_SETTINGS_KEY, value: nextReminders },
      {
        onError: (error) => {
          trpcUtils.settings.get.setData(
            { key: MEDICATION_REMINDERS_SETTINGS_KEY },
            previousSetting,
          );
          setWriteError(error.message);
          captureException(error, { context: "medication-reminders-write" });
        },
        onSettled: () => {
          void trpcUtils.settings.get.invalidate({ key: MEDICATION_REMINDERS_SETTINGS_KEY });
        },
      },
    );
  };

  const handleAdd = () => {
    const medicationName = draftName.trim();
    if (medicationName.length === 0) {
      setWriteError("Enter a medication name.");
      return;
    }

    const parseResult = medicationReminderSchema.safeParse({
      id: createReminderId(),
      medicationName,
      localTime: draftTime,
      enabled: true,
    });
    if (!parseResult.success) {
      setWriteError("Time must be in HH:mm 24-hour format (e.g., 08:30).");
      return;
    }

    persistReminders([...reminders, parseResult.data]);
    setDraftName("");
    setDraftTime("08:00");
  };

  return (
    <View style={styles.container}>
      {writeError ? <Text style={styles.errorText}>{writeError}</Text> : null}

      {reminders.length === 0 ? (
        <Text style={styles.emptyText}>No medication reminders yet.</Text>
      ) : (
        reminders.map((reminder) => {
          const loggingState = findLatestDoseLoggingState(reminder.medicationName, events);
          const isFocused = focusedReminderId === reminder.id;
          return (
            <View
              key={reminder.id}
              style={[styles.row, isFocused ? styles.focusedRow : null]}
              testID={isFocused ? "focused-medication-reminder" : undefined}
            >
              <Text style={styles.medicationName}>{reminder.medicationName}</Text>
              <Text style={styles.localTime}>{reminder.localTime}</Text>
              <Text style={styles.loggingState}>
                {loggingState
                  ? `Latest log: ${formatDoseStatus(loggingState.doseStatus)} · ${formatDateTime(new Date(loggingState.recordedAt))}`
                  : "No imported dose log yet."}
              </Text>
              <View style={styles.actions}>
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() =>
                    persistReminders(
                      reminders.map((item) =>
                        item.id === reminder.id ? { ...item, enabled: !item.enabled } : item,
                      ),
                    )
                  }
                  style={styles.actionButton}
                >
                  <Text style={styles.actionText}>{reminder.enabled ? "Disable" : "Enable"}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() =>
                    persistReminders(reminders.filter((item) => item.id !== reminder.id))
                  }
                  style={styles.actionButton}
                >
                  <Text style={styles.deleteText}>Delete</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        })
      )}

      <Text style={styles.fieldLabel}>Medication name</Text>
      <TextInput
        accessibilityLabel="Medication name"
        style={styles.input}
        value={draftName}
        onChangeText={setDraftName}
        placeholder="Vitamin D3"
        placeholderTextColor={colors.textTertiary}
      />
      <Text style={styles.fieldLabel}>Daily time (HH:mm)</Text>
      <TextInput
        accessibilityLabel="Daily time"
        style={styles.input}
        value={draftTime}
        onChangeText={setDraftTime}
        placeholder="08:00"
        placeholderTextColor={colors.textTertiary}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TouchableOpacity
        accessibilityRole="button"
        onPress={handleAdd}
        style={styles.addButton}
        disabled={setSettingMutation.isPending}
      >
        <Text style={styles.addButtonText}>Add reminder</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  errorText: {
    color: colors.danger,
    fontSize: 12,
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  row: {
    borderBottomColor: colors.surfaceSecondary,
    borderBottomWidth: 1,
    gap: 4,
    paddingBottom: spacing.sm,
  },
  focusedRow: {
    borderColor: colors.accent,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
  },
  medicationName: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "600",
  },
  localTime: {
    color: colors.textTertiary,
    fontSize: 12,
  },
  loggingState: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  actions: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  actionButton: {
    borderColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  actionText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  deleteText: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: "600",
  },
  fieldLabel: {
    color: colors.textTertiary,
    fontSize: 12,
    fontWeight: "600",
    marginTop: spacing.xs,
  },
  input: {
    borderColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    color: colors.text,
    fontSize: 15,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  addButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    marginTop: spacing.xs,
    paddingVertical: spacing.sm,
  },
  addButtonText: {
    color: colors.textInverse,
    fontSize: 14,
    fontWeight: "700",
  },
});
