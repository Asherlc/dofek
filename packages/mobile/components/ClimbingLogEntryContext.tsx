import { formatClimbingWallAngle } from "@dofek/format/climbing-context";
import { StyleSheet, Text, View } from "react-native";
import type { ClimbingLogEntryDetail } from "../../server/src/contracts/climbing-log-contracts.ts";
import { colors } from "../theme";

export function ClimbingLogEntryContext({ entry }: { entry: ClimbingLogEntryDetail }) {
  const location = entry.climb?.areaPath.at(-1)?.name;
  const angle = formatClimbingWallAngle(entry.wallAngle);
  return (
    <View style={styles.container}>
      {location && <Text style={styles.label}>{location}</Text>}
      {entry.board && <Text style={styles.label}>Board: {entry.board.name}</Text>}
      {angle && <Text style={styles.label}>{angle}</Text>}
    </View>
  );
}
const styles = StyleSheet.create({
  container: { flexShrink: 1, gap: 2 },
  label: { fontSize: 12, color: colors.textSecondary, flexShrink: 1 },
});
