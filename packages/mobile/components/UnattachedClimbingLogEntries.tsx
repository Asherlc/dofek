import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ClimbingLogEntryDetail } from "../../server/src/contracts/climbing-log-contracts.ts";
import { colors } from "../theme";
import { ClimbingLogEntryBreakdown } from "./ClimbingLogEntryBreakdown";

export type LogEntryAttachState = Record<string, { pending: boolean; error: string | null }>;
export function UnattachedClimbingLogEntries({
  suggestions,
  error,
  isLoading,
  state,
  onAttach,
}: {
  suggestions: readonly ClimbingLogEntryDetail[] | undefined;
  error: unknown | null;
  isLoading: boolean;
  state: LogEntryAttachState;
  onAttach: (climbingLogEntryId: string) => void;
}) {
  return (
    <View style={styles.container}>
      {Boolean(error) && (
        <Text accessibilityRole="alert" style={styles.error}>
          {userFacingErrorMessage(error)}
        </Text>
      )}
      {suggestions === undefined && isLoading ? (
        <Text style={styles.label}>Loading climbing logs...</Text>
      ) : suggestions === undefined && error ? null : !suggestions?.length ? (
        <Text style={styles.label}>No unattached climbing logs for this day.</Text>
      ) : (
        <>
          <Text style={styles.label}>Unattached</Text>
          {suggestions.map((entry) => (
            <View key={entry.id} style={styles.container}>
              <ClimbingLogEntryBreakdown entries={[entry]} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Attach to this activity"
                disabled={state[entry.id]?.pending}
                style={styles.button}
                onPress={() => onAttach(entry.id)}
              >
                <Text style={styles.action}>
                  {state[entry.id]?.pending ? "Attaching..." : "Attach"}
                </Text>
              </Pressable>
              {state[entry.id]?.error && (
                <Text accessibilityRole="alert" style={styles.error}>
                  {state[entry.id]?.error}
                </Text>
              )}
            </View>
          ))}
        </>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  container: { gap: 8 },
  label: { fontSize: 12, color: colors.textSecondary },
  error: { fontSize: 12, color: colors.negative },
  button: {
    alignSelf: "flex-end",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 6,
    backgroundColor: colors.accent,
  },
  action: { color: colors.text, fontSize: 13, fontWeight: "600" },
});
