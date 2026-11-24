import { formatActivityTypeLabel } from "@dofek/training/training";
import type { AppRouterOutputs } from "dofek-server/router";
import { Text, TouchableOpacity, View } from "react-native";
import {
  displayDuration,
  displayRecordLocalTime,
  formatActivityAccessibilityLabel,
} from "../lib/activity-list-presentation";
import type { useUnitConverter } from "../lib/units";
import { ActivityMapTile } from "./ActivityMapTile";
import { ActivityMetricStrip } from "./ActivityMetricStrip";
import { ActivityPhotoPreview } from "./ActivityPhotoPreview";
import { ActivitySourceDisclosure } from "./ActivitySourceDisclosure";
import { ActivityTypeIcon } from "./ActivityTypeIcon";
import { styles } from "./activities.styles";

type Activity = AppRouterOutputs["calendar"]["weekListV2"]["days"][number]["activities"][number];

export function CompletedActivityCard({
  activity,
  units,
  selectMode,
  selected,
  showCompleted = false,
  onPress,
}: {
  activity: Activity;
  units: ReturnType<typeof useUnitConverter>;
  selectMode: boolean;
  selected: boolean;
  showCompleted?: boolean;
  onPress: () => void;
}) {
  return (
    <View style={[styles.card, selected ? styles.cardSelected : null]}>
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={onPress}
        style={styles.cardAction}
        accessibilityRole="button"
        accessibilityLabel={formatActivityAccessibilityLabel(
          selectMode ? (selected ? "Deselect" : "Select") : "Open",
          activity,
          units,
        )}
        accessibilityState={{
          selected: selectMode ? selected : undefined,
        }}
      />
      <View style={styles.cardContent} pointerEvents="box-none">
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <ActivityTypeIcon
            activityType={activity.primaryActivityType ?? activity.activityType}
            size={40}
          />
        </View>
        <View style={styles.cardMain} pointerEvents="box-none">
          <View
            style={styles.titleRow}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Text style={styles.activityName} numberOfLines={1}>
              {activity.name ??
                formatActivityTypeLabel(activity.primaryActivityType ?? activity.activityType)}
            </Text>
            {showCompleted ? <Text style={styles.typePill}>Completed</Text> : null}
            {selectMode ? (
              <Text style={[styles.selectionPill, selected ? styles.selectionPillSelected : null]}>
                {selected ? "Selected" : "Select"}
              </Text>
            ) : null}
            {activity.name !== null &&
            activity.name !==
              formatActivityTypeLabel(activity.primaryActivityType ?? activity.activityType) ? (
              <Text style={styles.typePill}>
                {formatActivityTypeLabel(activity.primaryActivityType ?? activity.activityType)}
              </Text>
            ) : null}
          </View>
          <View style={styles.metaRow} pointerEvents="box-none">
            <View
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <Text style={styles.activityMeta}>
                {displayRecordLocalTime(activity.startedAt, activity.localTimeContext)} ·{" "}
                {displayDuration(activity.durationMin)}
              </Text>
            </View>
          </View>
          <View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <ActivityMetricStrip activity={activity} units={units} />
          </View>
        </View>
      </View>
      {activity.location ? (
        <View
          style={styles.mapPanel}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <ActivityMapTile location={activity.location} />
        </View>
      ) : !activity.isProviderAbsent ? (
        <View pointerEvents="none">
          <ActivityPhotoPreview activityId={activity.id} />
        </View>
      ) : null}
      <ActivitySourceDisclosure tree={activity.source.tree} />
    </View>
  );
}
