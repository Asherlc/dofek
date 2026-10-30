import { providerSourceLabel } from "@dofek/providers/providers";
import { type ActivityImage, activityImageCaption } from "@dofek/training/activity-images";
import { type ReactNode, useEffect, useState } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { captureException } from "../lib/telemetry";
import { colors, radius, spacing } from "../theme";
import { QueryStatePanel } from "./QueryStatePanel";

interface ActivityPhotoProps {
  image: ActivityImage;
  retryVersion?: number;
  onRetry?: () => void;
  onPress?: () => void;
  pressLabel?: string;
  resizeMode?: "cover" | "contain";
  style?: StyleProp<ViewStyle>;
}

export function ActivityPhoto(props: ActivityPhotoProps) {
  return <DownloadedPhoto key={props.image.url} {...props} />;
}

function DownloadedPhoto({
  image,
  retryVersion = 0,
  onRetry,
  onPress,
  pressLabel,
  resizeMode = "cover",
  style,
}: ActivityPhotoProps) {
  const [loaded, setLoaded] = useState(false);
  const [failedAttempt, setFailedAttempt] = useState<number | null>(null);
  const failed = failedAttempt === retryVersion;
  const caption = activityImageCaption(image);
  const photo = (
    <Image
      source={{ uri: image.url }}
      accessibilityLabel={caption}
      resizeMode={resizeMode}
      style={styles.image}
      onLoad={() => setLoaded(true)}
      onError={() => {
        setFailedAttempt(retryVersion);
        captureException(new Error("Activity photo failed to load"), { source: "activity-photo" });
      }}
    />
  );
  return (
    <View style={[styles.photo, style]}>
      {failed ? (
        <View style={styles.photoFailure} accessibilityRole="alert">
          <Text style={styles.photoFailureText}>Photo unavailable</Text>
          {onPress ? (
            <Pressable accessibilityRole="button" accessibilityLabel={pressLabel} onPress={onPress}>
              <Text style={styles.retry}>View photos</Text>
            </Pressable>
          ) : onRetry ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry photo"
              onPress={() => {
                setFailedAttempt(null);
                setLoaded(false);
                onRetry();
              }}
            >
              <Text style={styles.retry}>Retry</Text>
            </Pressable>
          ) : (
            <Text style={styles.photoFailureText}>Open activity to refresh photos.</Text>
          )}
        </View>
      ) : (
        <>
          {onPress ? (
            <Pressable
              style={styles.image}
              onPress={onPress}
              accessibilityRole="button"
              accessibilityLabel={pressLabel}
            >
              {photo}
            </Pressable>
          ) : (
            photo
          )}
          {!loaded && (
            <View style={styles.photoLoading} pointerEvents="none">
              <ActivityIndicator color={colors.accent} accessibilityLabel="Loading photo" />
            </View>
          )}
        </>
      )}
    </View>
  );
}

interface ActivityImagesProps {
  heading?: ReactNode;
  images: readonly ActivityImage[];
  onRetry: () => void;
  loading?: boolean;
  error?: { message: string } | null;
  retrying?: boolean;
  pendingMessage?: string;
  viewerLabel?: string;
}

export function ActivityImages({
  heading,
  images,
  onRetry,
  loading = false,
  error,
  retrying = false,
  pendingMessage,
  viewerLabel = "Activity photo",
}: ActivityImagesProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refresh = () => {
    setRefreshVersion((version) => version + 1);
    onRetry();
  };
  const firstImage = images[0];
  const selected = images.find((image) => image.id === selectedId);
  useEffect(() => {
    if (selectedId !== null && selected === undefined) setSelectedId(null);
  }, [selectedId, selected]);
  if (!images.length && !loading && !error && !pendingMessage) return <>{heading}</>;
  const thumbnails = (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.thumbnails}
    >
      {images.map((image, index) => (
        <ActivityPhoto
          key={image.id}
          image={image}
          retryVersion={refreshVersion}
          style={styles.thumbnail}
          onRetry={refresh}
          onPress={() => setSelectedId(image.id)}
          pressLabel={`Open photo ${index + 1}: ${activityImageCaption(image)}`}
        />
      ))}
    </ScrollView>
  );
  return (
    <View style={styles.gallery}>
      {heading ? (
        <View style={styles.summary}>
          {firstImage ? (
            <View style={styles.summaryPhoto}>
              <ActivityPhoto
                image={firstImage}
                retryVersion={refreshVersion}
                style={styles.summaryPhoto}
                onRetry={refresh}
                onPress={() => setSelectedId(firstImage.id)}
                pressLabel={`View ${images.length} ${images.length === 1 ? "photo" : "photos"}`}
              />
              {images.length > 1 ? (
                <Text pointerEvents="none" style={styles.count}>
                  {images.length}
                </Text>
              ) : null}
            </View>
          ) : null}
          <View style={styles.summaryHeading}>{heading}</View>
        </View>
      ) : (
        <Text style={styles.title}>Photos</Text>
      )}
      {pendingMessage && (
        <Text role="status" style={styles.source}>
          {pendingMessage}
        </Text>
      )}
      {error && (
        <QueryStatePanel
          variant="error"
          message={error.message}
          onRetry={refresh}
          retryLabel="Retry photos"
          retrying={retrying}
          minHeight={72}
        />
      )}
      {loading && images.length === 0 && !error && (
        <QueryStatePanel variant="loading" minHeight={96} />
      )}
      {!heading && images.length > 0 && thumbnails}
      {selected && (
        <Modal
          visible
          animationType="fade"
          presentationStyle="fullScreen"
          onRequestClose={() => setSelectedId(null)}
        >
          <View
            style={styles.viewer}
            role="dialog"
            accessibilityLabel={viewerLabel}
            accessibilityViewIsModal
          >
            <View style={styles.viewerHeader}>
              <Pressable
                onPress={refresh}
                disabled={retrying}
                accessibilityRole="button"
                accessibilityLabel="Refresh photos"
              >
                <Text style={styles.close}>{retrying ? "Refreshing…" : "Refresh photos"}</Text>
              </Pressable>
              <Pressable
                onPress={() => setSelectedId(null)}
                accessibilityRole="button"
                accessibilityLabel="Close photo"
                hitSlop={12}
              >
                <Text style={styles.close}>Close</Text>
              </Pressable>
            </View>
            {error && (
              <QueryStatePanel
                variant="error"
                message={error.message}
                onRetry={refresh}
                retrying={retrying}
                minHeight={72}
              />
            )}
            <ActivityPhoto
              image={selected}
              retryVersion={refreshVersion}
              style={styles.fullPhoto}
              resizeMode="contain"
              onRetry={refresh}
            />
            <Text style={styles.caption}>{activityImageCaption(selected)}</Text>
            {heading && images.length > 1 ? (
              <View style={styles.viewerThumbnails}>{thumbnails}</View>
            ) : null}
            {selected.sources.length > 0 && (
              <Text style={styles.source}>
                {[
                  ...new Set(
                    selected.sources.map((source) => providerSourceLabel(source.providerId)),
                  ),
                ].join(", ")}
              </Text>
            )}
          </View>
        </Modal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  summaryPhoto: { width: 80, height: 80, flexShrink: 0 },
  summaryHeading: { flex: 1, minWidth: 0 },
  count: {
    position: "absolute",
    bottom: 4,
    right: 4,
    backgroundColor: "rgba(0,0,0,0.7)",
    color: "#fff",
    borderRadius: 4,
    paddingHorizontal: 5,
    fontSize: 12,
  },
  viewerThumbnails: { height: 112, marginHorizontal: spacing.lg },
  gallery: { gap: spacing.sm },
  title: { color: colors.text, fontSize: 18, fontWeight: "700" },
  thumbnails: { gap: spacing.sm },
  thumbnail: { width: 136, height: 112 },
  photo: {
    position: "relative",
    backgroundColor: colors.surfaceSecondary,
    overflow: "hidden",
    borderRadius: radius.md,
  },
  image: { width: "100%", height: "100%" },
  photoLoading: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    justifyContent: "center",
    alignItems: "center",
  },
  photoFailure: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    padding: spacing.sm,
  },
  photoFailureText: { color: colors.textSecondary, fontSize: 12 },
  retry: { color: colors.accent, fontSize: 13, fontWeight: "600", padding: spacing.xs },
  viewer: { flex: 1, backgroundColor: colors.background, paddingTop: 56, paddingBottom: 32 },
  viewerHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  close: { color: colors.accent, fontSize: 16, fontWeight: "600", padding: spacing.sm },
  fullPhoto: { flex: 1, borderRadius: 0, backgroundColor: colors.background },
  caption: { color: colors.text, padding: spacing.lg, textAlign: "center", fontSize: 15 },
  source: {
    color: colors.textSecondary,
    textAlign: "center",
    fontSize: 13,
    paddingHorizontal: spacing.lg,
  },
});
