import { providerSourceLabel } from "@dofek/providers/providers";
import type { ClimbingLocationMapEntry } from "@dofek/training/climbing-location-map";
import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { colors, radius, spacing } from "../theme";
import { QueryStatePanel } from "./QueryStatePanel";

export function ClimbingLogAttachment({
  entry,
  onClose,
}: {
  entry: Pick<ClimbingLocationMapEntry, "id" | "date" | "label">;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const utils = trpc.useUtils();
  const activities = trpc.climbing.attachmentActivities.useQuery(
    { date: entry.date },
    { refetchOnMount: "always" },
  );
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null);
  const selectedActivity = activities.data?.find((activity) => activity.id === selectedActivityId);
  const attachment = trpc.climbing.attachClimbingLogEntry.useMutation({
    onSuccess: async (_result, input) => {
      await Promise.all([
        utils.climbing.locationMap.invalidate(),
        utils.climbing.activityLogEntries.invalidate({
          activityId: input.activityId,
          responseVersion: 3,
        }),
        utils.climbing.unattachedClimbingLogEntries.invalidate(),
        utils.climbing.sessionSummary.invalidate(),
        utils.mobileDashboard.trainingV2.invalidate(),
        utils.climbing.volumeByGrade.invalidate(),
        utils.climbing.strengths.invalidate(),
        utils.activity.images.invalidate({ id: input.activityId }),
        utils.activity.list.invalidate(),
        utils.calendar.weekList.invalidate(),
      ]);
      onClose();
    },
    onError: (error) => captureException(error),
  });

  function closePicker() {
    if (!attachment.isPending) onClose();
  }

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={closePicker}>
      <View style={styles.container} accessibilityViewIsModal>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>
            Attach to activity
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel attachment"
            accessibilityState={{ disabled: attachment.isPending }}
            disabled={attachment.isPending}
            onPress={closePicker}
            style={styles.cancel}
          >
            <Text style={styles.actionText}>Cancel</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.entryLabel}>
            {entry.label} · {entry.date}
          </Text>
          <Text style={styles.description}>
            Choose a recorded climbing or hiking activity from this day.
          </Text>
          {activities.error && (
            <QueryStatePanel
              variant="error"
              title="Could not load recorded activities"
              message={activities.error.message}
              onRetry={() => void activities.refetch()}
              retrying={activities.isFetching}
              minHeight={80}
            />
          )}
          {activities.isLoading && activities.data === undefined ? (
            <QueryStatePanel variant="loading" minHeight={80} />
          ) : activities.data?.length === 0 && !activities.error ? (
            <QueryStatePanel
              variant="empty"
              message={`No recorded climbing or hiking activities on ${entry.date}.`}
              minHeight={80}
            />
          ) : null}
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={`Activities on ${entry.date}`}
            style={styles.choices}
          >
            {activities.data?.map((activity) => {
              const typeLabel = activity.activityType === "climbing" ? "Climbing" : "Hiking";
              const recordedName = activity.name?.trim();
              const name = recordedName || typeLabel;
              const source = providerSourceLabel(activity.providerId);
              const details = recordedName
                ? [typeLabel, activity.startTime, source]
                : [activity.startTime, source];
              const selected = activity.id === selectedActivityId;
              return (
                <Pressable
                  key={activity.id}
                  accessibilityRole="radio"
                  accessibilityLabel={[name, ...details].join(", ")}
                  accessibilityState={{ checked: selected, disabled: attachment.isPending }}
                  disabled={attachment.isPending}
                  onPress={() => setSelectedActivityId(activity.id)}
                  style={[styles.choice, selected && styles.selectedChoice]}
                >
                  <View style={[styles.radio, selected && styles.selectedRadio]} />
                  <View style={styles.choiceText}>
                    <Text style={styles.activityName}>{name}</Text>
                    <Text style={styles.description}>{details.join(" · ")}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
          {attachment.error && (
            <QueryStatePanel
              variant="error"
              title="Could not attach climbing log"
              message={attachment.error.message}
              minHeight={80}
            />
          )}
        </ScrollView>
        <View style={[styles.footer, { paddingBottom: Math.max(spacing.md, insets.bottom) }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              attachment.isPending ? "Attaching log to activity" : "Attach log to selected activity"
            }
            accessibilityState={{
              disabled: !selectedActivity || attachment.isPending,
              busy: attachment.isPending,
            }}
            disabled={!selectedActivity || attachment.isPending}
            onPress={() => {
              if (!selectedActivity || attachment.isPending) return;
              attachment.mutate({ climbingLogEntryId: entry.id, activityId: selectedActivity.id });
            }}
            style={[styles.submit, (!selectedActivity || attachment.isPending) && styles.disabled]}
          >
            <Text style={styles.submitText}>
              {attachment.isPending ? "Attaching..." : "Attach"}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: spacing.md,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { color: colors.text, fontSize: 18, fontWeight: "600" },
  cancel: { padding: spacing.sm, minHeight: 44, justifyContent: "center" },
  actionText: { color: colors.accent, fontSize: 14, fontWeight: "600" },
  content: { padding: spacing.md, paddingBottom: spacing.xl, gap: spacing.md },
  entryLabel: { color: colors.text, fontSize: 14, fontWeight: "600" },
  description: { color: colors.textSecondary, fontSize: 13 },
  choices: { gap: spacing.sm },
  choice: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  selectedChoice: { borderColor: colors.accent },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.textSecondary,
  },
  selectedRadio: { borderColor: colors.accent, borderWidth: 5 },
  choiceText: { flex: 1, gap: spacing.xs },
  activityName: { color: colors.text, fontSize: 14, fontWeight: "600" },
  footer: {
    padding: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  submit: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  submitText: { color: colors.surface, fontSize: 14, fontWeight: "600" },
  disabled: { opacity: 0.5 },
});
