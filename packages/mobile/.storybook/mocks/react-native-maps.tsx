import { statusColors } from "@dofek/scoring/colors";
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

interface Coordinate {
  latitude: number;
  longitude: number;
}

interface MapViewProps {
  children?: ReactNode;
  style?: unknown;
}

interface PolylineProps {
  coordinates?: Coordinate[];
  strokeColor?: string;
}

interface MarkerProps {
  children?: ReactNode;
  coordinate?: Coordinate;
  pinColor?: string;
  title?: string;
}

export default function MapView({ children, style }: MapViewProps) {
  return (
    <View style={[styles.map, style]}>
      <View style={styles.grid} />
      {children}
    </View>
  );
}

export function Polyline({ coordinates = [], strokeColor = statusColors.positive }: PolylineProps) {
  if (coordinates.length === 0) return null;

  return (
    <View style={[styles.route, { borderColor: strokeColor }]}>
      <Text style={styles.routeText}>{coordinates.length} route points</Text>
    </View>
  );
}

export function Marker({ children, pinColor = statusColors.positive, title }: MarkerProps) {
  return (
    <View style={styles.markerWrap}>
      <View style={[styles.marker, { backgroundColor: pinColor }]} />
      {title ? <Text style={styles.markerLabel}>{title}</Text> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  map: {
    backgroundColor: "#d8e4dc",
    overflow: "hidden",
    position: "relative",
  },
  grid: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(255,255,255,0.28)",
  },
  route: {
    position: "absolute",
    left: "18%",
    right: "18%",
    top: "42%",
    height: 44,
    borderTopWidth: 4,
    borderRightWidth: 4,
    transform: [{ rotate: "-12deg" }],
    justifyContent: "center",
    alignItems: "center",
  },
  routeText: {
    color: "#214034",
    fontSize: 12,
    fontWeight: "600",
    transform: [{ rotate: "12deg" }],
  },
  markerWrap: {
    position: "absolute",
    top: "48%",
    left: "46%",
    alignItems: "center",
    gap: 3,
  },
  marker: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: "#ffffff",
  },
  markerLabel: {
    color: "#214034",
    fontSize: 10,
    fontWeight: "700",
  },
});
