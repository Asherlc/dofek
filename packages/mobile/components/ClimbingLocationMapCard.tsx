import { formatDateShort } from "@dofek/format/format";
import { providerSourceLabel } from "@dofek/providers/providers";
import type {
  ClimbingLocationMap,
  ClimbingLocationMapEntry,
} from "@dofek/training/climbing-location-map";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from "react-native";
import MapView, { Marker, type Region } from "react-native-maps";
import { colors, radius, spacing } from "../theme";
import { ClimbingLogAttachment } from "./ClimbingLogAttachment";
import { MapProcessingState } from "./MapProcessingState";
import { QueryStatePanel } from "./QueryStatePanel";

const MAP_HEIGHT = 280;

function zoomForRegion(region: Region, width: number) {
  return Math.max(
    0,
    Math.min(19, Math.floor(Math.log2((360 * width) / (256 * region.longitudeDelta)))),
  );
}

export function ClimbingLocationMapCard({
  data,
  loading = false,
  error,
}: {
  data: ClimbingLocationMap | undefined;
  loading?: boolean;
  error?: { message: string } | null;
}) {
  const router = useRouter();
  const map = useRef<MapView>(null);
  const [mapWidth, setMapWidth] = useState<number | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [attachmentEntry, setAttachmentEntry] = useState<ClimbingLocationMapEntry | null>(null);
  const south = data?.bounds?.south;
  const west = data?.bounds?.west;
  const north = data?.bounds?.north;
  const east = data?.bounds?.east;
  const fitRegion = useMemo<Region | null>(() => {
    if (south == null || west == null || north == null || east == null) return null;
    const longitudeSpan = east < west ? east + 360 - west : east - west;
    const longitude = west + longitudeSpan / 2;
    const latitude = (south + north) / 2;
    const latitudeScale = Math.max(0.01, Math.cos((latitude * Math.PI) / 180));
    const aspectRatio = (mapWidth ?? 320) / MAP_HEIGHT;
    const latitudeSpan = Math.max(0.005, (north - south) * 1.3);
    const paddedLongitudeSpan = Math.max(0.005, longitudeSpan * 1.3);
    return {
      latitude,
      longitude: longitude > 180 ? longitude - 360 : longitude,
      latitudeDelta: Math.min(
        170,
        Math.max(latitudeSpan, (paddedLongitudeSpan * latitudeScale) / aspectRatio),
      ),
      longitudeDelta: Math.min(
        360,
        Math.max(paddedLongitudeSpan, (latitudeSpan * aspectRatio) / latitudeScale),
      ),
    };
  }, [south, west, north, east, mapWidth]);

  useEffect(() => {
    if (!fitRegion) {
      setMapReady(false);
      return;
    }
    if (!mapWidth) return;
    setZoom(zoomForRegion(fitRegion, mapWidth));
    setSelectedId(null);
    map.current?.animateToRegion(fitRegion, 300);
  }, [fitRegion, mapWidth]);

  const selected = data?.nodes.find((node) => node.id === selectedId);

  function handleLayout(event: LayoutChangeEvent) {
    const width = event.nativeEvent.layout.width;
    if (width > 0) setMapWidth(width);
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Climbing locations</Text>
      {error && (
        <QueryStatePanel
          variant="error"
          title="Could not load climbing locations"
          message={error.message}
          minHeight={80}
        />
      )}
      {fitRegion ? (
        <View
          testID="climbing-location-map-wrapper"
          style={styles.mapWrapper}
          onLayout={handleLayout}
        >
          {mapWidth != null && mapWidth > 0 && (
            <MapView
              ref={map}
              style={{ width: mapWidth, height: MAP_HEIGHT }}
              initialRegion={fitRegion}
              onRegionChangeComplete={(region) => setZoom(zoomForRegion(region, mapWidth))}
              scrollEnabled
              zoomEnabled
              rotateEnabled={false}
              pitchEnabled={false}
              showsUserLocation={false}
              showsPointsOfInterests={false}
              toolbarEnabled={false}
              onMapReady={() => setMapReady(true)}
              loadingEnabled
              loadingIndicatorColor={colors.accent}
              loadingBackgroundColor={colors.surfaceSecondary}
            >
              {data?.nodes
                .filter((node) => node.minZoom <= zoom && zoom <= node.maxZoom)
                .map((node) => {
                  const label =
                    node.expansionZoom != null
                      ? `${node.count} climbs · Zoom in`
                      : node.count > 1
                        ? `${node.count} climbs at this location`
                        : (node.entries[0]?.label ?? "Climb location");
                  return (
                    <Marker
                      key={node.id}
                      identifier={node.id}
                      coordinate={node.coordinates}
                      title={label}
                      accessibilityRole="button"
                      accessibilityLabel={label}
                      anchor={{ x: 0.5, y: 0.5 }}
                      onPress={() => {
                        if (node.expansionZoom != null) {
                          const longitudeDelta = (360 * mapWidth) / (256 * 2 ** node.expansionZoom);
                          map.current?.animateToRegion(
                            {
                              ...node.coordinates,
                              longitudeDelta,
                              latitudeDelta:
                                (longitudeDelta *
                                  MAP_HEIGHT *
                                  Math.cos((node.coordinates.latitude * Math.PI) / 180)) /
                                mapWidth,
                            },
                            300,
                          );
                          setSelectedId(null);
                        } else {
                          setSelectedId(node.id);
                        }
                      }}
                    >
                      <View
                        style={[
                          styles.dot,
                          {
                            width: node.radius * 2,
                            height: node.radius * 2,
                            borderRadius: node.radius,
                          },
                        ]}
                      >
                        {node.count > 1 && <Text style={styles.count}>{node.count}</Text>}
                      </View>
                    </Marker>
                  );
                })}
            </MapView>
          )}
          {!mapReady && (
            <View style={StyleSheet.absoluteFill}>
              <MapProcessingState />
            </View>
          )}
        </View>
      ) : loading && data == null ? (
        <View style={styles.mapWrapper}>
          <MapProcessingState />
        </View>
      ) : !error ? (
        <QueryStatePanel variant="empty" message="No climbing locations in this period" />
      ) : null}
      {selected && (
        <View accessibilityLabel="Climbs at this location" style={styles.entries}>
          {selected.entries.map((entry) => (
            <View key={entry.id} style={styles.entry}>
              <Text style={styles.entryName}>{entry.label}</Text>
              <Text style={styles.metadata}>
                {entry.grade ? `${entry.grade} · ` : ""}
                {formatDateShort(entry.date)}
              </Text>
              <Text style={styles.metadata}>
                {entry.location.scope === "area" ? "Area location" : "Climb location"}:{" "}
                {entry.location.name ?? entry.location.objectId} ·{" "}
                {providerSourceLabel(entry.location.providerId)}
              </Text>
              {entry.activityId ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`View activity for ${entry.label}`}
                  onPress={() => router.push(`/activity/${entry.activityId}`)}
                  style={styles.activityLink}
                >
                  <Text style={styles.activityLinkText}>View activity</Text>
                </Pressable>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Attach to activity for ${entry.label}`}
                  onPress={() => setAttachmentEntry(entry)}
                  style={styles.activityLink}
                >
                  <Text style={styles.activityLinkText}>Attach to activity</Text>
                </Pressable>
              )}
            </View>
          ))}
        </View>
      )}
      {attachmentEntry && (
        <ClimbingLogAttachment entry={attachmentEntry} onClose={() => setAttachmentEntry(null)} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.md,
    gap: spacing.md,
  },
  title: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  mapWrapper: { height: MAP_HEIGHT, borderRadius: radius.lg, overflow: "hidden" },
  dot: {
    backgroundColor: colors.accent,
    borderColor: "#ffffff",
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  count: { color: colors.background, fontWeight: "700", fontSize: 12 },
  entries: { gap: spacing.md },
  entry: { gap: spacing.xs },
  entryName: { color: colors.text, fontSize: 14, fontWeight: "600" },
  metadata: { color: colors.textSecondary, fontSize: 12 },
  activityLink: { alignSelf: "flex-start", paddingVertical: spacing.sm },
  activityLinkText: { color: colors.accent, fontSize: 13, fontWeight: "600" },
});
