import { formatClimbingWallAngle } from "@dofek/format/climbing-context";
import { formatDateTime } from "@dofek/format/format";
import { StyleSheet, Text, View } from "react-native";
import type { ClimbingLogEntryDetail } from "../../server/src/contracts/climbing-log-contracts.ts";
import { colors } from "../theme";

export function ClimbingLogEntryContext({ entry }: { entry: ClimbingLogEntryDetail }) {
  const angle = formatClimbingWallAngle(entry.wallAngle);
  const recordedAt = entry.chartAnnotations?.[0]?.startedAt;
  return (
    <View style={styles.container}>
      {entry.board && <Text style={styles.label}>Board: {entry.board.name}</Text>}
      {angle && <Text style={styles.label}>{angle}</Text>}
      {recordedAt && <Text style={styles.label}>{formatDateTime(recordedAt)}</Text>}
    </View>
  );
}
const styles = StyleSheet.create({
  container: { flexShrink: 1, gap: 2 },
  label: { fontSize: 12, color: colors.textSecondary, flexShrink: 1 },
});
