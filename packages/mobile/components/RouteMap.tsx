import { providerSourceLabel } from "@dofek/providers/providers";
import { statusColors } from "@dofek/scoring/colors";
import { type ClimbingMapMarker, groupClimbingMapMarkers } from "@dofek/training/climbing-map";
import { createMapStyle } from "@dofek/training/map-style";
import {
  Camera,
  GeoJSONSource,
  Layer,
  Marker,
  Map as NativeMap,
} from "@maplibre/maplibre-react-native";
import { useCallback, useMemo, useState } from "react";
import { type LayoutChangeEvent, StyleSheet, Text, useColorScheme, View } from "react-native";
import { captureException } from "../lib/telemetry";
import { colors, radius, spacing } from "../theme";
import { CompactRouteMap } from "./CompactRouteMap";
import { MapAttribution } from "./MapAttribution";
import { MapProcessingState } from "./MapProcessingState";
import { QueryStatePanel } from "./QueryStatePanel";

interface GpsPoint {
  lat: number | null;
  lng: number | null;
}

interface RouteMapProps {
  selectedEntryId?: string | null;
  points: GpsPoint[];
  hoveredPosition?: { lat: number; lng: number } | null;
  climbMarkers?: readonly ClimbingMapMarker[];
  compact?: boolean;
  onSelectEntry?: (entryId: string) => void;
}

const MAP_HEIGHT = 280;
const NO_CLIMB_MARKERS: readonly ClimbingMapMarker[] = [];

export function RouteMap({
  points,
  hoveredPosition,
  climbMarkers = NO_CLIMB_MARKERS,
  compact = false,
  onSelectEntry,
  selectedEntryId: controlledEntryId,
}: RouteMapProps) {
  const mode = useColorScheme() === "dark" ? "dark" : "light";
  const mapStyle = useMemo(() => createMapStyle(mode), [mode]);
  const [mapFailed, setMapFailed] = useState(false);
  const [mapWidth, setMapWidth] = useState<number | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const activeEntryId = controlledEntryId === undefined ? selectedEntryId : controlledEntryId;
  const markerGroups = useMemo(
    () => groupClimbingMapMarkers(climbMarkers, providerSourceLabel),
    [climbMarkers],
  );

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    if (width > 0) setMapWidth(width);
  }, []);

  const gpsPoints = useMemo(
    () =>
      points.filter(
        (point): point is { lat: number; lng: number } => point.lat != null && point.lng != null,
      ),
    [points],
  );

  const bounds = useMemo<[number, number, number, number] | null>(() => {
    const mapPoints = [
      ...gpsPoints,
      ...(climbMarkers ?? []).map(({ location }) => ({
        lat: location.coordinates.latitude,
        lng: location.coordinates.longitude,
      })),
    ];
    const firstPoint = mapPoints[0];
    if (!firstPoint) return null;

    let minLat = firstPoint.lat;
    let maxLat = firstPoint.lat;
    let minLng = firstPoint.lng;
    let maxLng = firstPoint.lng;

    for (const point of mapPoints) {
      if (point.lat < minLat) minLat = point.lat;
      if (point.lat > maxLat) maxLat = point.lat;
      if (point.lng < minLng) minLng = point.lng;
      if (point.lng > maxLng) maxLng = point.lng;
    }

    const latDelta = Math.max((maxLat - minLat) * 1.3, 0.005);
    const lngDelta = Math.max((maxLng - minLng) * 1.3, 0.005);

    return [
      (minLng + maxLng - lngDelta) / 2,
      (minLat + maxLat - latDelta) / 2,
      (minLng + maxLng + lngDelta) / 2,
      (minLat + maxLat + latDelta) / 2,
    ];
  }, [gpsPoints, climbMarkers]);
  const initialViewState = useMemo(() => (bounds ? { bounds } : undefined), [bounds]);

  const coordinates = useMemo(
    () => gpsPoints.map((point): [number, number] => [point.lng, point.lat]),
    [gpsPoints],
  );

  if (bounds == null) return null;
  if (compact)
    return (
      <View style={styles.compactContainer}>
        <CompactRouteMap
          bounds={bounds}
          coordinates={coordinates}
          markerGroups={markerGroups}
          hoveredPosition={hoveredPosition}
          mode={mode}
        />
        <MapAttribution />
      </View>
    );

  const startCoordinate = coordinates[0];
  const endCoordinate = coordinates[coordinates.length - 1];

  return (
    <View style={styles.container}>
      {gpsPoints.length > 0 && <Text style={styles.title}>Route Map</Text>}
      <View
        testID="climbing-map"
        style={[styles.mapWrapper, { height: MAP_HEIGHT }]}
        onLayout={handleLayout}
      >
        {mapWidth != null && (
          <NativeMap
            style={{ width: mapWidth, height: MAP_HEIGHT }}
            pointerEvents="auto"
            mapStyle={mapStyle}
            dragPan
            touchZoom
            doubleTapZoom
            doubleTapHoldZoom
            touchRotate={false}
            touchPitch={false}
            attribution
            onDidFinishLoadingMap={() => setMapReady(true)}
            onDidFailLoadingMap={() => {
              captureException(new Error("Route map failed to load"));
              setMapFailed(true);
            }}
          >
            <Camera initialViewState={initialViewState} bounds={bounds} duration={0} />
            {coordinates.length > 1 && (
              <GeoJSONSource
                id="activity-route"
                data={{
                  type: "Feature",
                  properties: {},
                  geometry: { type: "LineString", coordinates },
                }}
              >
                <Layer
                  id="activity-route-line"
                  type="line"
                  paint={{ "line-color": statusColors.positive, "line-width": 3 }}
                  layout={{ "line-cap": "round", "line-join": "round" }}
                />
              </GeoJSONSource>
            )}
            {startCoordinate != null && (
              <Marker id="route-start" lngLat={startCoordinate} accessibilityLabel="Start">
                <View style={[styles.sourceMarker, { backgroundColor: statusColors.positive }]} />
              </Marker>
            )}
            {endCoordinate != null && (
              <Marker id="route-finish" lngLat={endCoordinate} accessibilityLabel="Finish">
                <View style={[styles.sourceMarker, { backgroundColor: statusColors.danger }]} />
              </Marker>
            )}
            {markerGroups.map(({ coordinates, markers, title, description }) => (
              <Marker
                key={`${coordinates.latitude}:${coordinates.longitude}`}
                id={markers[0].entryId}
                lngLat={[coordinates.longitude, coordinates.latitude]}
                accessibilityLabel={title}
                accessibilityHint={description}
                accessibilityState={{
                  selected: markers.some((marker) => marker.entryId === activeEntryId),
                }}
                anchor="center"
                onPress={() => {
                  setSelectedEntryId(markers[0].entryId);
                  onSelectEntry?.(markers[0].entryId);
                }}
              >
                <View
                  style={[
                    styles.sourceMarker,
                    markers.every((marker) => marker.location.scope === "area") &&
                      styles.areaMarker,
                    markers.length > 1 && styles.groupMarker,
                    markers.some((marker) => marker.entryId === activeEntryId) &&
                      styles.selectedMarker,
                  ]}
                >
                  {markers.length > 1 && <Text style={styles.markerCount}>{markers.length}</Text>}
                </View>
              </Marker>
            ))}
            {hoveredPosition != null && (
              <Marker
                id="route-hover"
                lngLat={[hoveredPosition.lng, hoveredPosition.lat]}
                accessibilityLabel="Selected chart position"
                anchor="center"
              >
                <View style={styles.hoverMarker} />
              </Marker>
            )}
          </NativeMap>
        )}
        {mapFailed && (
          <View style={StyleSheet.absoluteFill}>
            <QueryStatePanel
              variant="error"
              message="Map unavailable. Check your connection and reopen this activity."
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
      <MapAttribution />
    </View>
  );
}

const styles = StyleSheet.create({
  compactContainer: { overflow: "hidden", borderRadius: radius.lg },
  container: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.md,
    gap: 12,
  },
  title: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  mapWrapper: {
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  hoverMarker: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: "#ffffff",
    borderWidth: 3,
    borderColor: statusColors.positive,
  },
  sourceMarker: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.accent,
    borderWidth: 2,
    borderColor: "#ffffff",
  },
  selectedMarker: { borderColor: "#15803d", borderWidth: 4 },
  areaMarker: { backgroundColor: statusColors.warning },
  groupMarker: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  markerCount: { color: "#ffffff", fontSize: 12, fontWeight: "700" },
});
