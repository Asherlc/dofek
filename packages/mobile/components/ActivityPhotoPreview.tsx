import { ACTIVITY_IMAGES_QUERY_OPTIONS } from "@dofek/training/activity-images";
import { StyleSheet, Text, View } from "react-native";
import { trpc } from "../lib/trpc";
import { colors, spacing } from "../theme";
import { ActivityPhoto } from "./ActivityImages";
import { QueryStatePanel } from "./QueryStatePanel";

export function ActivityPhotoPreview({ activityId }: { activityId: string }) {
  const query = trpc.activity.images.useQuery({ id: activityId }, ACTIVITY_IMAGES_QUERY_OPTIONS);
  const image = query.data?.images[0];
  if (!image && !query.error && !query.isLoading) return null;
  return (
    <View style={styles.container}>
      {query.error && (
        <View accessibilityRole="alert" style={styles.error}>
          <Text style={styles.errorText}>{query.error.message}</Text>
          <Text style={styles.errorText}>Open activity to refresh photos.</Text>
        </View>
      )}
      {image ? (
        <ActivityPhoto image={image} style={styles.photo} />
      ) : query.isLoading && !query.error ? (
        <QueryStatePanel variant="loading" minHeight={72} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm, paddingHorizontal: spacing.sm, paddingBottom: spacing.sm },
  photo: { width: "100%", aspectRatio: 16 / 9 },
  error: { gap: spacing.xs, padding: spacing.sm },
  errorText: { color: colors.textSecondary, fontSize: 12 },
});
