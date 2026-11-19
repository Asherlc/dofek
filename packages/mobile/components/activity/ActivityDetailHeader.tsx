import { formatDateLong } from "@dofek/format/format";
import { formatRecordLocalTime, formatRecordLocalTimeRange } from "@dofek/format/record-local-time";
import { providerLabel } from "@dofek/providers/providers";
import { formatActivityTypeLabel } from "@dofek/training/training";
import type { ActivityDetail } from "dofek-server/types";
import type { ComponentProps, ReactNode } from "react";
import { Text, useWindowDimensions, View } from "react-native";
import { ActivityImages } from "../ActivityImages";
import { ActivitySourceDisclosure } from "../ActivitySourceDisclosure";
import { ActivityTypeIcon } from "../ActivityTypeIcon";
import { ProviderAbsentBanner } from "./ProviderAbsentBanner";
import { styles } from "./styles";

export function ActivityDetailHeader({
  activity,
  photos,
  actions,
  showLineage = true,
  ...hardwareProps
}: {
  actions?: ReactNode;
  showLineage?: boolean;
  photos?: Omit<ComponentProps<typeof ActivityImages>, "heading">;
  activity: Pick<
    ActivityDetail,
    | "id"
    | "name"
    | "activityType"
    | "primaryActivityType"
    | "displayedDate"
    | "startedAt"
    | "localTimeContext"
    | "sourceTree"
    | "climbingLogSessions"
    | "providerId"
    | "subsource"
    | "providerAbsentAt"
    | "fitRecoveryWarning"
  >;
} & Omit<ComponentProps<typeof ActivitySourceDisclosure>, "tree">) {
  const { fontScale } = useWindowDimensions();
  const largeText = fontScale > 1;
  const viewerTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localStartTime = formatRecordLocalTime(
    activity.startedAt,
    activity.localTimeContext,
    "start",
    undefined,
    viewerTimezone,
  );

  const name =
    activity.name ?? formatActivityTypeLabel(activity.primaryActivityType ?? activity.activityType);
  const typeLabel = formatActivityTypeLabel(activity.activityType);

  const identityHeader = largeText ? (
    <>
      <Text style={styles.name}>{name}</Text>
      <View style={styles.largeTextMetaRow}>
        <View style={[styles.typeBadge, styles.largeTextBadge]}>
          <Text style={styles.typeBadgeText}>{typeLabel}</Text>
        </View>
        {actions}
      </View>
    </>
  ) : (
    <View style={styles.headerRow}>
      {!photos?.images.length && (
        <ActivityTypeIcon activityType={activity.activityType} size={48} />
      )}
      <View style={styles.headerText}>
        <Text style={styles.name}>{name}</Text>
        <View style={styles.typeBadge}>
          <Text style={styles.typeBadgeText}>{typeLabel}</Text>
        </View>
      </View>
      {actions}
    </View>
  );

  const identity = (
    <View style={styles.header}>
      {identityHeader}
      <Text style={styles.dateTime}>
        {formatDateLong(activity.displayedDate, { timeZone: "UTC" })}
        {" at "}
        {localStartTime === "--" ? "Local time unavailable" : localStartTime}
      </Text>
      {activity.climbingLogSessions.length > 0 ? (
        <View style={{ gap: 4, marginTop: 8 }}>
          {activity.climbingLogSessions.map((session) => {
            const window = formatRecordLocalTimeRange(
              session.firstLoggedAt,
              session.lastLoggedAt,
              activity.localTimeContext,
              undefined,
              viewerTimezone,
            );
            const label = `${providerLabel(session.providerId)} · Logged climbs · ${window}`;
            return (
              <Text key={session.id} accessibilityLabel={label} style={styles.dateTime}>
                {label}
              </Text>
            );
          })}
        </View>
      ) : null}
    </View>
  );
  const heading = showLineage ? (
    <ActivitySourceDisclosure tree={activity.sourceTree} {...hardwareProps} heading={identity} />
  ) : (
    identity
  );

  return (
    <View style={styles.header}>
      {photos ? <ActivityImages {...photos} heading={heading} /> : heading}
      {activity.fitRecoveryWarning ? (
        <View accessible accessibilityRole="alert" style={styles.providerAbsentBanner}>
          <Text style={styles.providerAbsentExplanation}>{activity.fitRecoveryWarning}</Text>
        </View>
      ) : null}
      <ProviderAbsentBanner key={`restore-${activity.id}`} activity={activity} />
    </View>
  );
}
