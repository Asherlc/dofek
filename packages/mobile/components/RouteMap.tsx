import { providerSourceLabel } from "@dofek/providers/providers";
import { statusColors } from "@dofek/scoring/colors";
import type { ClimbingMapMarker, GpsCoordinates } from "@dofek/training/climbing-map";
import { useCallback, useMemo, useState } from "react";
import { type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from "react-native";
import MapView, { Marker, Polyline } from "react-native-maps";
import { colors, radius, spacing } from "../theme";

interface GpsPoint {
  lat: number | null;
  lng: number | null;
}

interface RouteMapProps {
  points: GpsPoint[];
  hoveredPosition?: { lat: number; lng: number } | null;
  climbMarkers?: readonly ClimbingMapMarker[];
  compact?: boolean;
  onSelectEntry?: (entryId: string) => void;
}

const MAP_HEIGHT = 280;

export function RouteMap({
  points,
  hoveredPosition,
  climbMarkers,
  compact = false,
  onSelectEntry,
}: RouteMapProps) {
  const [mapWidth, setMapWidth] = useState<number | null>(null);
  const [inspectedPoint, setInspectedPoint] = useState<GpsCoordinates | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setMapWidth(event.nativeEvent.layout.width);
  }, []);

  const gpsPoints = useMemo(
    () =>
      points.filter(
        (point): point is { lat: number; lng: number } => point.lat != null && point.lng != null,
      ),
    [points],
  );

  const region = useMemo(() => {
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

    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLng + maxLng) / 2,
      latitudeDelta: latDelta,
      longitudeDelta: lngDelta,
    };
  }, [gpsPoints, climbMarkers]);

  if (region == null) return null;

  const coordinates = gpsPoints.map((point) => ({
    latitude: point.lat,
    longitude: point.lng,
  }));

  const startCoordinate = coordinates[0];
  const endCoordinate = coordinates[coordinates.length - 1];

  return (
    <View style={compact ? styles.compactContainer : styles.container}>
      {!compact && (
        <Text style={styles.title}>{gpsPoints.length > 0 ? "Route Map" : "Climb locations"}</Text>
      )}
      <View style={styles.mapWrapper} onLayout={handleLayout}>
        {mapWidth != null && (
          <MapView
            style={{ width: mapWidth, height: compact ? 140 : MAP_HEIGHT }}
            region={region}
            scrollEnabled={false}
            zoomEnabled={false}
            rotateEnabled={false}
            pitchEnabled={false}
            toolbarEnabled={false}
            showsUserLocation={false}
            showsPointsOfInterests={false}
          >
            {coordinates.length > 0 && (
              <Polyline
                coordinates={coordinates}
                strokeColor={statusColors.positive}
                strokeWidth={3}
              />
            )}
            {startCoordinate != null && (
              <Marker coordinate={startCoordinate} pinColor={statusColors.positive} title="Start" />
            )}
            {endCoordinate != null && (
              <Marker coordinate={endCoordinate} pinColor={statusColors.danger} title="Finish" />
            )}
            {climbMarkers?.map(({ entryId, entryNumber, label, location }, index) => (
              <Marker
                key={entryId}
                identifier={entryId}
                coordinate={location.coordinates}
                title={`Entry ${entryNumber ?? index + 1} · ${label}`}
                description={`${location.scope === "area" ? "Area location" : "Climb location"}: ${location.name ?? location.objectId} · ${providerSourceLabel(location.providerId)}`}
                anchor={{ x: 0.5, y: 0.5 }}
                onPress={compact ? undefined : () => setInspectedPoint(location.coordinates)}
              >
                <View
                  style={[styles.sourceMarker, location.scope === "area" && styles.areaMarker]}
                />
              </Marker>
            ))}
            {hoveredPosition != null && (
              <Marker
                coordinate={{
                  latitude: hoveredPosition.lat,
                  longitude: hoveredPosition.lng,
                }}
                anchor={{ x: 0.5, y: 0.5 }}
              >
                <View style={styles.hoverMarker} />
              </Marker>
            )}
          </MapView>
        )}
      </View>
      {!compact && inspectedPoint && (
        <View accessibilityLabel="Climbing entries at this location" style={styles.occurrences}>
          {climbMarkers?.map((marker, index) => {
            const { latitude, longitude } = marker.location.coordinates;
            if (latitude !== inspectedPoint.latitude || longitude !== inspectedPoint.longitude)
              return null;
            const label = `Entry ${marker.entryNumber ?? index + 1} · ${marker.label}`;
            return (
              <Pressable
                key={marker.entryId}
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityState={{ selected: selectedEntryId === marker.entryId }}
                style={styles.occurrence}
                onPress={() => {
                  setSelectedEntryId(marker.entryId);
                  onSelectEntry?.(marker.entryId);
                }}
              >
                <Text style={styles.occurrenceLabel}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
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
  areaMarker: { backgroundColor: statusColors.warning },
  occurrences: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  occurrence: {
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.lg,
    padding: 10,
    maxWidth: "100%",
  },
  occurrenceLabel: { color: colors.accent, fontSize: 13, flexShrink: 1 },
});
