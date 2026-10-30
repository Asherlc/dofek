import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import { StyleSheet, Text, View } from "react-native";
import type { ClimbingLogEntryDetail } from "../../server/src/contracts/climbing-log-contracts.ts";
import { colors } from "../theme";
import { ClimbingLogEntryBreakdown } from "./ClimbingLogEntryBreakdown";

export type LogEntryAttachState = Record<string, { pending: boolean; error: string | null }>;
export function UnattachedClimbingLogEntries({
  suggestions,
  showEntries = true,
  error,
  isLoading,
  state,
  onAttach,
  locations,
  selectedEntryId,
}: {
  showEntries?: boolean;
  suggestions: readonly ClimbingLogEntryDetail[] | undefined;
  error: unknown | null;
  isLoading: boolean;
  state: LogEntryAttachState;
  onAttach: (climbingLogEntryId: string) => void;
  locations?: Readonly<Record<string, ClimbingMapLocation>>;
  selectedEntryId?: string | null;
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
      ) : showEntries ? (
        <>
          <Text style={styles.label}>Unattached</Text>
          <ClimbingLogEntryBreakdown
            entries={suggestions}
            locations={locations}
            selectedEntryId={selectedEntryId}
            attachmentStates={state}
            onAttach={onAttach}
          />
        </>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  container: { gap: 8 },
  label: { fontSize: 12, color: colors.textSecondary },
  error: { fontSize: 12, color: colors.negative },
});
