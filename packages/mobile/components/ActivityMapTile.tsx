import { providerSourceLabel } from "@dofek/providers/providers";
import { createMapStyle } from "@dofek/training/map-style";
import type { StaticMapCreateOptions } from "@maplibre/maplibre-react-native";
import type { ActivityLocation } from "dofek-server/types";
import { useMemo, useState } from "react";
import {
  Image,
  type LayoutChangeEvent,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import Svg, { Circle, Polyline } from "react-native-svg";
import { useNativeMapSnapshot } from "../lib/native-map-snapshot";
import { colors, radius } from "../theme";
import { MapAttribution } from "./MapAttribution";
import { MapProcessingState } from "./MapProcessingState";

type ReadyActivityLocation = Exclude<ActivityLocation, { kind: "processing" }>;

export function ActivityMapTile({ location }: { location: ActivityLocation }) {
  const mode = useColorScheme() === "dark" ? "dark" : "light";
  if (location.kind === "processing") {
    return (
      <View style={[styles.container, { aspectRatio: 16 / 9 }]}>
        <MapProcessingState />
      </View>
    );
  }
  return (
    <ReadyMapTile
      key={`${mode}:${JSON.stringify(location.mapPreview)}`}
      location={location}
      mode={mode}
    />
  );
}

function ReadyMapTile({
  location,
  mode,
}: {
  location: ReadyActivityLocation;
  mode: "light" | "dark";
}) {
  const [width, setWidth] = useState<number | null>(null);
  const mapStyle = useMemo(() => createMapStyle(mode), [mode]);
  const { mapPreview } = location;
  const { center, zoom, width: referenceWidth, height: referenceHeight } = mapPreview;
  const longitude = center[0];
  const latitude = center[1];
  // Native cameras stop at zoom zero. Enlarge only low-zoom images enough to
  // keep the complete reference viewport, then scale the image with its SVG.
  const renderScale = width == null ? null : Math.max(width / referenceWidth, 2 ** -zoom);
  const snapshotWidth = renderScale == null ? null : referenceWidth * renderScale;
  const snapshotHeight = renderScale == null ? null : referenceHeight * renderScale;
  const snapshotZoom = renderScale == null ? null : Math.max(0, zoom + Math.log2(renderScale));
  const options = useMemo<StaticMapCreateOptions | null>(
    () =>
      snapshotWidth != null && snapshotHeight != null && snapshotZoom != null
        ? {
            center: [longitude, latitude],
            zoom: snapshotZoom,
            width: snapshotWidth,
            height: snapshotHeight,
            mapStyle,
            output: "base64",
            logo: false,
          }
        : null,
    [longitude, latitude, snapshotWidth, snapshotHeight, snapshotZoom, mapStyle],
  );
  function handleLayout(event: LayoutChangeEvent) {
    const nextWidth = event.nativeEvent.layout.width;
    if (nextWidth > 0) setWidth(nextWidth);
  }
  const snapshot = useNativeMapSnapshot(options);
  const { uri, ready: mapReady, failed: loadFailed } = snapshot;
  const accessibilityLabel =
    location.kind === "climbing_source"
      ? `Climbing source locations: ${location.sourcePoints
          .map(
            ({ location: point }) =>
              `${point.scope === "area" ? "Area location" : "Climb location"}${point.name ? `: ${point.name}` : ""} · ${providerSourceLabel(point.providerId)}`,
          )
          .join("; ")}`
      : "Activity location map";

  return (
    <View
      testID="activity-map-panel"
      onLayout={handleLayout}
      style={[styles.container, { aspectRatio: mapPreview.width / mapPreview.height }]}
    >
      {loadFailed ? (
        <View style={styles.fallback} accessibilityLabel="Activity location unavailable" accessible>
          <Text style={styles.fallbackText}>Map unavailable</Text>
        </View>
      ) : (
        <>
          <View
            testID="activity-route-viewport"
            style={StyleSheet.absoluteFill}
            accessibilityLabel={mapReady ? accessibilityLabel : undefined}
            accessible={mapReady}
          >
            {uri && (
              <Image
                key={uri}
                testID="activity-map-preview"
                source={{ uri }}
                style={StyleSheet.absoluteFill}
                resizeMode="stretch"
                pointerEvents="none"
                onLoad={snapshot.onLoad}
                onError={snapshot.onError}
              />
            )}
            <ActivityMapOverlay location={location} />
          </View>
          <View pointerEvents="none" style={styles.attribution}>
            <MapAttribution />
          </View>
          {!mapReady && (
            <View style={StyleSheet.absoluteFill}>
              <MapProcessingState />
            </View>
          )}
        </>
      )}
    </View>
  );
}

function ActivityMapOverlay({ location }: { location: ReadyActivityLocation }) {
  const { mapPreview } = location;
  if (location.kind === "climbing_source") {
    return (
      <View testID="activity-source-overlay" pointerEvents="none" style={StyleSheet.absoluteFill}>
        {location.sourcePoints.map((point) => (
          <Svg
            key={`${point.location.providerId}-${point.location.scope}-${point.location.objectId}`}
            testID="activity-source-marker"
            width={16}
            height={16}
            viewBox="0 0 16 16"
            style={{
              ...styles.sourceMarker,
              left: `${(point.x / mapPreview.width) * 100}%`,
              top: `${(point.y / mapPreview.height) * 100}%`,
            }}
          >
            <Circle
              testID="activity-source-point"
              cx={8}
              cy={8}
              r={6}
              fill={point.location.scope === "area" ? "#d97706" : "#2563eb"}
              stroke="#fff"
              strokeWidth={2}
            />
          </Svg>
        ))}
      </View>
    );
  }

  const { routePath } = mapPreview;
  if (routePath == null || routePath.length < 2) return null;

  const points = routePath
    .map((point) => `${formatRouteCoordinate(point.x)},${formatRouteCoordinate(point.y)}`)
    .join(" ");
  return (
    <Svg
      testID="activity-route-overlay"
      pointerEvents="none"
      width="100%"
      height="100%"
      style={StyleSheet.absoluteFill}
      viewBox={`0 0 ${mapPreview.width} ${mapPreview.height}`}
      preserveAspectRatio="none"
    >
      <Polyline
        points={points}
        fill="none"
        stroke="#fff"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={5}
        vectorEffect="non-scaling-stroke"
      />
      <Polyline
        testID="activity-route-path"
        points={points}
        fill="none"
        stroke={colors.positive}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={3}
        vectorEffect="non-scaling-stroke"
      />
    </Svg>
  );
}

function formatRouteCoordinate(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

const styles = StyleSheet.create({
  container: {
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSecondary,
    overflow: "hidden",
    position: "relative",
    width: "100%",
  },
  attribution: { position: "absolute", right: 3, bottom: 2, backgroundColor: colors.surface },
  sourceMarker: {
    position: "absolute",
    transform: [{ translateX: -8 }, { translateY: -8 }],
  },
  fallback: { width: "100%", height: "100%", alignItems: "center", justifyContent: "center" },
  fallbackText: { color: colors.textSecondary, fontSize: 12, fontWeight: "600" },
});
