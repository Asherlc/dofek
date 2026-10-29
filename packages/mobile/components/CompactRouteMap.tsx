import { statusColors, surfaceColors } from "@dofek/scoring/colors";
import type { groupClimbingMapMarkers } from "@dofek/training/climbing-map";
import { createMapStyle } from "@dofek/training/map-style";
import type { StaticMapCreateOptions, StyleSpecification } from "@maplibre/maplibre-react-native";
import { useMemo, useState } from "react";
import { Image, type LayoutChangeEvent, StyleSheet, View } from "react-native";
import { useNativeMapSnapshot } from "../lib/native-map-snapshot";
import { MapProcessingState } from "./MapProcessingState";
import { QueryStatePanel } from "./QueryStatePanel";

export function CompactRouteMap({
  bounds,
  coordinates,
  markerGroups,
  hoveredPosition,
  mode,
}: {
  bounds: [number, number, number, number];
  coordinates: [number, number][];
  markerGroups: ReturnType<typeof groupClimbingMapMarkers>;
  hoveredPosition?: { lat: number; lng: number } | null;
  mode: "light" | "dark";
}) {
  const [width, setWidth] = useState<number | null>(null);
  const mapStyle = useMemo<StyleSpecification>(() => {
    const features: GeoJSON.Feature[] = [];
    const point = (lngLat: [number, number], properties: GeoJSON.GeoJsonProperties) =>
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: lngLat },
        properties,
      });
    if (coordinates.length > 1)
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates },
        properties: {},
      });
    if (coordinates[0])
      point(coordinates[0], { color: statusColors.positive, radius: 5, role: "start" });
    const end = coordinates[coordinates.length - 1];
    if (end) point(end, { color: statusColors.danger, radius: 5, role: "finish" });
    for (const group of markerGroups) {
      const area = group.markers.every((marker) => marker.location.scope === "area");
      point([group.coordinates.longitude, group.coordinates.latitude], {
        color: area ? statusColors.warning : surfaceColors.accent,
        radius: group.markers.length > 1 ? 12 : 5,
        label: group.markers.length > 1 ? String(group.markers.length) : "",
        scope: area ? "area" : "climb",
        role: "source",
      });
    }
    if (hoveredPosition)
      point([hoveredPosition.lng, hoveredPosition.lat], {
        color: "#ffffff",
        radius: 4,
        role: "hover",
      });
    const shared = createMapStyle(mode);
    return {
      ...shared,
      sources: {
        ...shared.sources,
        "compact-activity": { type: "geojson", data: { type: "FeatureCollection", features } },
      },
      layers: [
        ...shared.layers,
        {
          id: "compact-route",
          type: "line",
          source: "compact-activity",
          filter: ["==", ["geometry-type"], "LineString"],
          paint: { "line-color": statusColors.positive, "line-width": 3 },
          layout: { "line-cap": "round", "line-join": "round" },
        },
        {
          id: "compact-points",
          type: "circle",
          source: "compact-activity",
          filter: ["==", ["geometry-type"], "Point"],
          paint: {
            "circle-color": ["get", "color"],
            "circle-radius": ["get", "radius"],
            "circle-stroke-color": [
              "case",
              ["==", ["get", "role"], "hover"],
              statusColors.positive,
              "#ffffff",
            ],
            "circle-stroke-width": ["case", ["==", ["get", "role"], "hover"], 3, 2],
          },
        },
        {
          id: "compact-counts",
          type: "symbol",
          source: "compact-activity",
          filter: ["has", "label"],
          layout: {
            "text-field": ["get", "label"],
            "text-font": ["Noto Sans Regular"],
            "text-size": 12,
            "text-allow-overlap": true,
          },
          paint: { "text-color": "#ffffff" },
        },
      ],
    };
  }, [coordinates, markerGroups, hoveredPosition, mode]);
  const options = useMemo<StaticMapCreateOptions | null>(
    () => (width ? { bounds, width, height: 140, mapStyle, output: "base64", logo: false } : null),
    [bounds, width, mapStyle],
  );
  const snapshot = useNativeMapSnapshot(options);
  const label = markerGroups.length
    ? markerGroups.map((group) => `${group.title}. ${group.description}`).join("; ")
    : "Activity route map";
  function measure(event: LayoutChangeEvent) {
    if (event.nativeEvent.layout.width > 0) setWidth(event.nativeEvent.layout.width);
  }
  return (
    <View
      onLayout={measure}
      pointerEvents="none"
      style={styles.viewport}
      accessibilityLabel={snapshot.ready ? label : undefined}
      accessible={snapshot.ready}
    >
      {snapshot.failed ? (
        <QueryStatePanel
          variant="error"
          message="Map unavailable. Check your connection and reopen this activity."
          minHeight={140}
        />
      ) : (
        <>
          {snapshot.uri && (
            <Image
              testID="compact-route-preview"
              source={{ uri: snapshot.uri }}
              resizeMode="stretch"
              style={StyleSheet.absoluteFill}
              onLoad={snapshot.onLoad}
              onError={snapshot.onError}
            />
          )}
          {!snapshot.ready && (
            <View style={StyleSheet.absoluteFill}>
              <MapProcessingState />
            </View>
          )}
        </>
      )}
    </View>
  );
}
const styles = StyleSheet.create({ viewport: { height: 140, width: "100%", overflow: "hidden" } });
