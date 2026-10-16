import { providerSourceLabel } from "@dofek/providers/providers";
import type { ActivityLocation } from "dofek-server/types";
import { useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Polyline } from "react-native-svg";
import { colors, radius, spacing } from "../theme";
import { MapProcessingState } from "./MapProcessingState";

type ReadyActivityLocation = Exclude<ActivityLocation, { kind: "processing" }>;

export function ActivityMapTile({ location }: { location: ActivityLocation }) {
  if (location.kind === "processing") {
    return (
      <View style={[styles.container, { aspectRatio: 16 / 9 }]}>
        <MapProcessingState />
      </View>
    );
  }
  return <ReadyMapTile key={JSON.stringify(location.mapPreview)} location={location} />;
}

function ReadyMapTile({ location }: { location: ReadyActivityLocation }) {
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadedTiles, setLoadedTiles] = useState<ReadonlySet<number>>(() => new Set());
  const { mapPreview } = location;
  const mapReady = loadedTiles.size === location.mapPreview.tiles.length;
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
    <View style={[styles.container, { aspectRatio: mapPreview.width / mapPreview.height }]}>
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
            {mapPreview.tiles.map((tile, index) => (
              <Image
                key={`${tile.url}-${tile.x}-${tile.y}`}
                testID="activity-map-preview-tile"
                source={{ uri: tile.url }}
                style={{
                  position: "absolute",
                  left: `${(tile.x / mapPreview.width) * 100}%`,
                  top: `${(tile.y / mapPreview.height) * 100}%`,
                  width: `${(tile.width / mapPreview.width) * 100}%`,
                  height: `${(tile.height / mapPreview.height) * 100}%`,
                }}
                resizeMode="cover"
                onLoad={() => setLoadedTiles((previous) => new Set([...previous, index]))}
                onError={() => setLoadFailed(true)}
              />
            ))}
            <ActivityMapOverlay location={location} />
            {location.kind === "climbing_source" && (
              <View style={styles.sourceLocationBadge}>
                <Text style={styles.sourceLocationBadgeText}>Source locations</Text>
              </View>
            )}
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
  sourceMarker: {
    position: "absolute",
    transform: [{ translateX: -8 }, { translateY: -8 }],
  },
  sourceLocationBadge: {
    position: "absolute",
    bottom: spacing.sm,
    left: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  sourceLocationBadgeText: { color: colors.textSecondary, fontSize: 11 },
  fallback: { width: "100%", height: "100%", alignItems: "center", justifyContent: "center" },
  fallbackText: { color: colors.textSecondary, fontSize: 12, fontWeight: "600" },
});
