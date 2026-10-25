import { formatDateLong } from "@dofek/format/format";
import { formatRecordLocalTime } from "@dofek/format/record-local-time";
import { formatActivityTypeLabel } from "@dofek/training/training";
import type { ActivityDetail } from "dofek-server/types";
import type { ComponentProps } from "react";
import { Text, View } from "react-native";
import { ActivitySourceDisclosure } from "../ActivitySourceDisclosure";
import { ActivityTypeIcon } from "../ActivityTypeIcon";
import { ProviderAbsentBanner } from "./ProviderAbsentBanner";
import { styles } from "./styles";

export function ActivityDetailHeader({
  activity,
  ...hardwareProps
}: {
  activity: Pick<
    ActivityDetail,
    | "name"
    | "activityType"
    | "displayedDate"
    | "startedAt"
    | "localTimeContext"
    | "sourceTree"
    | "providerId"
    | "subsource"
    | "providerAbsentAt"
  >;
} & Omit<ComponentProps<typeof ActivitySourceDisclosure>, "tree">) {
  const localStartTime = formatRecordLocalTime(
    activity.startedAt,
    activity.localTimeContext,
    "start",
    undefined,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );

  return (
    <View style={styles.header}>
      <View style={styles.headerRow}>
        <ActivityTypeIcon activityType={activity.activityType} size={48} />
        <View style={styles.headerText}>
          <Text style={styles.name}>
            {activity.name ?? formatActivityTypeLabel(activity.activityType)}
          </Text>
          <View style={styles.typeBadge}>
            <Text style={styles.typeBadgeText}>
              {formatActivityTypeLabel(activity.activityType)}
            </Text>
          </View>
        </View>
      </View>
      <Text style={styles.dateTime}>
        {formatDateLong(activity.displayedDate, { timeZone: "UTC" })}
        {" at "}
        {localStartTime === "--" ? "Local time unavailable" : localStartTime}
      </Text>
      <ActivitySourceDisclosure tree={activity.sourceTree} {...hardwareProps} />
      {activity.providerAbsentAt && <ProviderAbsentBanner activity={activity} />}
    </View>
  );
}
