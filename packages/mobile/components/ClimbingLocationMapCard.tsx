import { formatDateShort } from "@dofek/format/format";
import { providerSourceLabel } from "@dofek/providers/providers";
import type {
  ClimbingLocationMap,
  ClimbingLocationMapEntry,
} from "@dofek/training/climbing-location-map";
import { createMapStyle } from "@dofek/training/map-style";
import { Camera, type CameraRef, Marker, Map as NativeMap } from "@maplibre/maplibre-react-native";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { captureException } from "../lib/telemetry";
import { colors, radius, spacing } from "../theme";
import { ClimbingLogAttachment } from "./ClimbingLogAttachment";
import { MapAttribution } from "./MapAttribution";
import { MapProcessingState } from "./MapProcessingState";
import { QueryStatePanel } from "./QueryStatePanel";

const MAP_HEIGHT = 280;

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
  const camera = useRef<CameraRef>(null);
  const mode = useColorScheme() === "dark" ? "dark" : "light";
  const mapStyle = useMemo(() => createMapStyle(mode), [mode]);
  const [mapFailed, setMapFailed] = useState(false);
  const [mapWidth, setMapWidth] = useState<number | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [attachmentEntry, setAttachmentEntry] = useState<ClimbingLocationMapEntry | null>(null);
  const south = data?.bounds?.south;
  const west = data?.bounds?.west;
  const north = data?.bounds?.north;
  const east = data?.bounds?.east;
  const fitBounds = useMemo<[number, number, number, number] | null>(() => {
    if (south == null || west == null || north == null || east == null) return null;
    const longitudeSpan = east < west ? east + 360 - west : east - west;
    const longitude = west + longitudeSpan / 2;
    const latitude = (south + north) / 2;
    const latSpan = Math.max(0.005, (north - south) * 1.3);
    const lngSpan = Math.max(0.005, longitudeSpan * 1.3);
    return [
      longitude - lngSpan / 2,
      latitude - latSpan / 2,
      longitude + lngSpan / 2,
      latitude + latSpan / 2,
    ];
  }, [south, west, north, east]);
  const initialViewState = useMemo(
    () => (fitBounds ? { bounds: fitBounds } : undefined),
    [fitBounds],
  );

  useEffect(() => {
    if (!fitBounds) {
      setMapReady(false);
      setMapFailed(false);
      return;
    }
    if (!mapWidth) return;
    setSelectedId(null);
    camera.current?.fitBounds(fitBounds, {
      duration: 300,
      padding: { top: 10, bottom: 10, left: 10, right: 10 },
    });
  }, [fitBounds, mapWidth]);

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
      {fitBounds ? (
        <View
          testID="climbing-location-map-wrapper"
          style={styles.mapWrapper}
          onLayout={handleLayout}
        >
          {mapWidth != null && mapWidth > 0 && (
            <NativeMap
              style={{ width: mapWidth, height: MAP_HEIGHT }}
              mapStyle={mapStyle}
              onRegionDidChange={(event) =>
                setZoom(Math.max(0, Math.min(19, Math.floor(event.nativeEvent.zoom + 1))))
              }
              dragPan
              touchZoom
              touchRotate={false}
              touchPitch={false}
              attribution
              onDidFinishLoadingMap={() => setMapReady(true)}
              onDidFailLoadingMap={() => {
                captureException(new Error("Climbing location map failed to load"));
                setMapFailed(true);
              }}
            >
              <Camera ref={camera} initialViewState={initialViewState} />
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
                      id={node.id}
                      lngLat={[node.coordinates.longitude, node.coordinates.latitude]}
                      accessibilityRole="button"
                      accessibilityLabel={label}
                      anchor="center"
                      onPress={() => {
                        if (node.expansionZoom != null) {
                          camera.current?.easeTo({
                            center: [node.coordinates.longitude, node.coordinates.latitude],
                            zoom: node.expansionZoom - 1,
                            duration: 300,
                          });
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
            </NativeMap>
          )}
          {mapFailed && (
            <View style={StyleSheet.absoluteFill}>
              <QueryStatePanel
                variant="error"
                message="Map unavailable. Check your connection and reopen climbing locations."
                minHeight={MAP_HEIGHT}
              />
            </View>
          )}
          {!mapReady && !mapFailed && (
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
      {fitBounds && <MapAttribution />}
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
