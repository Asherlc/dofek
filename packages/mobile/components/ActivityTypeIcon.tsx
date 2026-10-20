import { getActivityIconInfo } from "@dofek/training/activity-icons";
import { formatActivityTypeLabel } from "@dofek/training/training";
import { StyleSheet, Text, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { radius } from "../theme";

interface ActivityTypeIconProps {
  activityType: string;
  size?: number;
}

export function ActivityTypeIcon({ activityType, size = 96 }: ActivityTypeIconProps) {
  const { emoji, svg, gradientFrom } = getActivityIconInfo(activityType);
  const label = formatActivityTypeLabel(activityType);
  const fontSize = Math.round(size * 0.42);

  return (
    <View
      testID="activity-type-icon"
      accessibilityLabel={`${label} activity`}
      accessible={true}
      style={[
        styles.container,
        { width: size, height: size, borderRadius: radius.md, backgroundColor: gradientFrom },
      ]}
    >
      {svg ? (
        <SvgXml xml={svg} width={size * 0.75} height={size * 0.75} />
      ) : (
        <Text style={[styles.emoji, { fontSize }]}>{emoji}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  emoji: {
    lineHeight: undefined,
  },
});
