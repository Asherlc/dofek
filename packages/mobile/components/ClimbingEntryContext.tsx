import {
  formatClimbingLocationPath,
  formatClimbingResultStyle,
  formatClimbingStyle,
  formatClimbingWallAngle,
} from "@dofek/format/climbing-context";
import type { ClimbingContext } from "@dofek/training/climbing-context";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

export function ClimbingEntryContext({
  context,
  sent,
}: {
  context: ClimbingContext;
  sent: boolean | null;
}) {
  const location = formatClimbingLocationPath(context.locationPath);
  const method = formatClimbingStyle(context.climbStyle);
  const angle = formatClimbingWallAngle(context.wallAngle);
  return (
    <View style={styles.container}>
      {location && <Text style={styles.label}>{location}</Text>}
      {context.board && <Text style={styles.label}>Board: {context.board.name}</Text>}
      {angle && <Text style={styles.label}>{angle}</Text>}
      {method && <Text style={styles.label}>{method}</Text>}
      <Text style={sent === true ? styles.sent : styles.label}>
        {formatClimbingResultStyle(context.resultStyle)}
      </Text>
    </View>
  );
}
const styles = StyleSheet.create({
  container: { flexShrink: 1, gap: 2 },
  label: { fontSize: 12, color: colors.textSecondary, flexShrink: 1 },
  sent: { fontSize: 12, color: colors.positive, fontWeight: "500", flexShrink: 1 },
});
