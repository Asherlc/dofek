import { providerSourceLabel } from "@dofek/providers/providers";
import type { ActivityLocation } from "dofek-server/types";
import { useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Polyline } from "react-native-svg";
import { colors, radius } from "../theme";
import { MapProcessingState } from "./MapProcessingState";

type ReadyActivityLocation = Exclude<ActivityLocation, { kind: "processing" }>;
const TILE_SIZE = 96;

export function ActivityMapTile({ location }: { location: ActivityLocation }) {
  if (location.kind === "processing") {
    return (
      <View style={styles.container}>
        <MapProcessingState />
      </View>
    );
  }
  return <ReadyMapTile key={JSON.stringify(location.mapPreview)} location={location} />;
}

function ReadyMapTile({ location }: { location: ReadyActivityLocation }) {
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadedTiles, setLoadedTiles] = useState<ReadonlySet<number>>(() => new Set());
  const previewScale = Math.min(
    TILE_SIZE / location.mapPreview.width,
    TILE_SIZE / location.mapPreview.height,
  );
  const previewWidth = location.mapPreview.width * previewScale;
  const previewHeight = location.mapPreview.height * previewScale;
  const previewLeft = (TILE_SIZE - previewWidth) / 2;
  const previewTop = (TILE_SIZE - previewHeight) / 2;
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
    <View style={styles.container}>
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
            {location.mapPreview.tiles.map((tile, index) => (
              <Image
                key={`${tile.url}-${tile.x}-${tile.y}`}
                testID="activity-map-preview-tile"
                source={{ uri: tile.url }}
                style={{
                  position: "absolute",
                  left: previewLeft + tile.x * previewScale,
                  top: previewTop + tile.y * previewScale,
                  width: tile.width * previewScale,
                  height: tile.height * previewScale,
                }}
                resizeMode="cover"
                onLoad={() => setLoadedTiles((previous) => new Set([...previous, index]))}
                onError={() => setLoadFailed(true)}
              />
            ))}
            <ActivityMapOverlay
              location={location}
              width={previewWidth}
              height={previewHeight}
              left={previewLeft}
              top={previewTop}
            />
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

function ActivityMapOverlay({
  location,
  width,
  height,
  left,
  top,
}: {
  location: ReadyActivityLocation;
  width: number;
  height: number;
  left: number;
  top: number;
}) {
  const { mapPreview } = location;
  const { routePath } = mapPreview;
  if (location.kind === "recorded_gps" && (routePath == null || routePath.length < 2)) return null;

  const points = routePath
    ?.map((point) => `${formatRouteCoordinate(point.x)},${formatRouteCoordinate(point.y)}`)
    .join(" ");
  return (
    <Svg
      testID={
        location.kind === "climbing_source" ? "activity-source-overlay" : "activity-route-overlay"
      }
      pointerEvents="none"
      style={{ position: "absolute", left, top, width, height }}
      viewBox={`0 0 ${mapPreview.width} ${mapPreview.height}`}
      preserveAspectRatio="none"
    >
      {location.kind === "climbing_source" ? (
        location.sourcePoints.map((point) => (
          <Circle
            key={`${point.location.providerId}-${point.location.scope}-${point.location.objectId}`}
            testID="activity-source-point"
            cx={point.x}
            cy={point.y}
            r={36}
            fill={point.location.scope === "area" ? "#d97706" : "#2563eb"}
            stroke="#fff"
            strokeWidth={16}
          />
        ))
      ) : (
        <>
          <Polyline
            points={points}
            fill="none"
            stroke="#fff"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={60}
          />
          <Polyline
            testID="activity-route-path"
            points={points}
            fill="none"
            stroke={colors.positive}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={30}
          />
        </>
      )}
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
    height: TILE_SIZE,
    backgroundColor: colors.surfaceSecondary,
    overflow: "hidden",
    position: "relative",
    width: TILE_SIZE,
  },
  fallback: { width: "100%", height: "100%", alignItems: "center", justifyContent: "center" },
  fallbackText: { color: colors.textSecondary, fontSize: 12, fontWeight: "600" },
});
