import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";

export function ActivityPerceivedExertion({
  activityId,
  value,
}: {
  activityId: string;
  value: number | null;
}) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState<number | null>(value);
  const mutation = trpc.activity.setPerceivedExertion.useMutation({
    onSuccess: (result) => {
      setDraft(result.perceivedExertion);
      void utils.activity.byId.invalidate({ id: activityId });
    },
    onError: (error) => captureException(error, { operation: "activity.setPerceivedExertion" }),
  });

  useEffect(() => setDraft(value), [value]);

  return (
    <View style={styles.container} accessibilityLabel="Session perceived exertion">
      <Text style={styles.title}>Session effort</Text>
      <Text style={styles.subtitle}>Your perceived exertion for this session (0–10).</Text>
      <View style={styles.row}>
        <Pressable
          style={styles.adjustButton}
          onPress={() => setDraft(Math.max(0, (draft ?? 0) - 1))}
          accessibilityLabel="Decrease perceived exertion"
        >
          <Text style={styles.adjustText}>−</Text>
        </Pressable>
        <Text style={styles.value}>{draft == null ? "—" : draft}</Text>
        <Pressable
          style={styles.adjustButton}
          onPress={() => setDraft(Math.min(10, (draft ?? 0) + 1))}
          accessibilityLabel="Increase perceived exertion"
        >
          <Text style={styles.adjustText}>+</Text>
        </Pressable>
        <Pressable
          style={styles.saveButton}
          onPress={() => mutation.mutate({ id: activityId, value: draft })}
          disabled={mutation.isPending}
        >
          <Text style={styles.saveText}>Save</Text>
        </Pressable>
        <Pressable
          style={styles.clearButton}
          onPress={() => mutation.mutate({ id: activityId, value: null })}
          disabled={mutation.isPending}
        >
          <Text style={styles.clearText}>Clear</Text>
        </Pressable>
      </View>
      {mutation.error ? <Text style={styles.error}>{mutation.error.message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: colors.surface, borderRadius: 16, padding: 16, gap: 6 },
  title: { color: colors.text, fontSize: 16, fontWeight: "700" },
  subtitle: { color: colors.textSecondary, fontSize: 12 },
  row: { alignItems: "center", flexDirection: "row", gap: 10, marginTop: 8 },
  adjustButton: {
    alignItems: "center",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 8,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  adjustText: { color: colors.text, fontSize: 20 },
  value: { color: colors.text, fontSize: 20, fontWeight: "700", minWidth: 28, textAlign: "center" },
  saveButton: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  saveText: { color: colors.background, fontSize: 12, fontWeight: "700" },
  clearButton: {
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  clearText: { color: colors.text, fontSize: 12 },
  error: { color: colors.danger, fontSize: 12, marginTop: 4 },
});
