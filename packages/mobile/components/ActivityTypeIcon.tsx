import { getActivityIconInfo } from "@dofek/training/activity-icons";
import { formatActivityTypeLabel } from "@dofek/training/training";
import { type ColorValue, StyleSheet, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { colors, radius } from "../theme";

interface ActivityTypeIconProps {
  activityType: string;
  size?: number;
  color?: ColorValue;
}

export function ActivityTypeIcon({
  activityType,
  size = 96,
  color = colors.text,
}: ActivityTypeIconProps) {
  const { svg } = getActivityIconInfo(activityType);
  const label = formatActivityTypeLabel(activityType);

  return (
    <View
      testID="activity-type-icon"
      accessibilityLabel={`${label} activity`}
      accessible={true}
      style={[styles.container, { width: size, height: size, borderRadius: radius.md }]}
    >
      <SvgXml xml={svg} width={size * 0.75} height={size * 0.75} color={color} accessible={false} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
});
