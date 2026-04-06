import { statusColors } from "@dofek/scoring/colors";
import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import MapView, { Marker, Polyline } from "react-native-maps";
import { colors, radius, spacing } from "../theme";
import { ChartTitleWithTooltip } from "./ChartTitleWithTooltip";

interface GpsPoint {
  lat: number | null;
  lng: number | null;
}

interface RouteMapProps {
  points: GpsPoint[];
}

const MAP_HEIGHT = 280;

export function RouteMap({ points }: RouteMapProps) {
  const gpsPoints = useMemo(
    () =>
      points.filter(
        (point): point is { lat: number; lng: number } => point.lat != null && point.lng != null,
      ),
    [points],
  );

  const region = useMemo(() => {
    if (gpsPoints.length === 0) return null;

    let minLat = gpsPoints[0].lat;
    let maxLat = gpsPoints[0].lat;
    let minLng = gpsPoints[0].lng;
    let maxLng = gpsPoints[0].lng;

    for (const point of gpsPoints) {
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
  }, [gpsPoints]);

  if (gpsPoints.length === 0 || region == null) return null;

  const coordinates = gpsPoints.map((point) => ({
    latitude: point.lat,
    longitude: point.lng,
  }));

  const startCoordinate = coordinates[0];
  const endCoordinate = coordinates[coordinates.length - 1];

  return (
    <View style={styles.container}>
      <ChartTitleWithTooltip
        title="Route Map"
        description="This map shows your recorded route, including start and finish locations."
        textStyle={styles.title}
      />
      <View style={styles.mapWrapper}>
        <MapView
          style={styles.map}
          initialRegion={region}
          scrollEnabled={false}
          zoomEnabled={false}
          rotateEnabled={false}
          pitchEnabled={false}
          toolbarEnabled={false}
          showsUserLocation={false}
          showsPointsOfInterest={false}
        >
          <Polyline coordinates={coordinates} strokeColor={statusColors.positive} strokeWidth={3} />
          {startCoordinate != null && (
            <Marker coordinate={startCoordinate} pinColor={statusColors.positive} title="Start" />
          )}
          {endCoordinate != null && (
            <Marker coordinate={endCoordinate} pinColor={statusColors.danger} title="Finish" />
          )}
        </MapView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
  map: {
    width: "100%",
    height: MAP_HEIGHT,
  },
});
