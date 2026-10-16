import { statusColors } from "@dofek/scoring/colors";
import {
  Children,
  createContext,
  forwardRef,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Svg, { Polyline as SvgPolyline } from "react-native-svg";

interface Coordinate {
  latitude: number;
  longitude: number;
}

interface MapViewProps {
  children?: ReactNode;
  style?: unknown;
  initialRegion?: Region;
  region?: Region;
  onRegionChangeComplete?: (region: Region) => void;
  onMapReady?: () => void;
  zoomEnabled?: boolean;
}

interface MapPreviewHandle {
  animateToRegion: (region: Region, duration?: number) => void;
}

interface Region extends Coordinate {
  latitudeDelta: number;
  longitudeDelta: number;
}
const MapPreview = createContext<{ region: Region; select: (markerId: string) => void } | null>(
  null,
);

function useMapPreview() {
  const preview = useContext(MapPreview);
  if (!preview) throw new Error("Storybook map markers and routes require a MapView region.");
  return preview;
}

function project(coordinate: Coordinate, region: Region) {
  return {
    x: Number(
      (50 + ((coordinate.longitude - region.longitude) / region.longitudeDelta) * 100).toFixed(4),
    ),
    y: Number(
      (50 - ((coordinate.latitude - region.latitude) / region.latitudeDelta) * 100).toFixed(4),
    ),
  };
}

interface PolylineProps {
  coordinates?: Coordinate[];
  strokeColor?: string;
}

interface MarkerProps {
  children?: ReactNode;
  coordinate: Coordinate;
  pinColor?: string;
  title?: string;
  description?: string;
  identifier?: string;
  onPress?: () => void;
}

function markerId({ identifier, title, coordinate }: MarkerProps) {
  return identifier ?? `${title ?? "Map point"}:${coordinate.latitude}:${coordinate.longitude}`;
}

const MapView = forwardRef<MapPreviewHandle, MapViewProps>(function MapView(
  { children, style, initialRegion, region, onRegionChangeComplete, onMapReady, zoomEnabled },
  ref,
) {
  const [mountedRegion, setMountedRegion] = useState(initialRegion);
  const [selectedId, select] = useState<string | null>(null);
  const hasStartedRendering = useRef(false);
  useEffect(() => {
    if (hasStartedRendering.current) return;
    hasStartedRendering.current = true;
    onMapReady?.();
  }, [onMapReady]);
  const viewport = region ?? mountedRegion;
  function updateRegion(nextRegion: Region) {
    setMountedRegion(nextRegion);
    onRegionChangeComplete?.(nextRegion);
  }
  useImperativeHandle(ref, () => ({ animateToRegion: updateRegion }));
  if (!viewport) throw new Error("Storybook MapView requires region or initialRegion.");
  const markers = Children.toArray(children).filter(
    (child): child is ReactElement<MarkerProps> =>
      isValidElement<MarkerProps>(child) && child.type === Marker,
  );
  const selected = markers.find((marker) => markerId(marker.props) === selectedId)?.props;
  return (
    <View style={[styles.preview, style]}>
      <View style={styles.map}>
        <View style={styles.grid} />
        <MapPreview.Provider value={{ region: viewport, select }}>{children}</MapPreview.Provider>
      </View>
      {zoomEnabled && (
        <View style={styles.zoomControls}>
          {(
            [
              ["Zoom in", 0.5],
              ["Zoom out", 2],
            ] as const
          ).map(([label, scale]) => (
            <Pressable
              key={label}
              accessibilityRole="button"
              accessibilityLabel={label}
              onPress={() =>
                updateRegion({
                  ...viewport,
                  latitudeDelta: viewport.latitudeDelta * scale,
                  longitudeDelta: viewport.longitudeDelta * scale,
                })
              }
              style={styles.zoomButton}
            >
              <Text>{label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {markers.length > 0 && (
        <ScrollView style={styles.inspection}>
          {selected && (
            <View accessibilityLabel="Selected map point" style={styles.details}>
              {selected.title && <Text style={styles.markerLabel}>{selected.title}</Text>}
              {selected.description && (
                <Text style={styles.description}>{selected.description}</Text>
              )}
              <Text style={styles.description}>
                Latitude {selected.coordinate.latitude} · Longitude {selected.coordinate.longitude}
              </Text>
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
});

export default MapView;

export function Polyline({ coordinates = [], strokeColor = statusColors.positive }: PolylineProps) {
  const { region } = useMapPreview();
  if (coordinates.length === 0) return null;

  return (
    <Svg
      style={StyleSheet.absoluteFillObject}
      width="100%"
      height="100%"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      <SvgPolyline
        points={coordinates
          .map((coordinate) => {
            const { x, y } = project(coordinate, region);
            return `${x},${y}`;
          })
          .join(" ")}
        stroke={strokeColor}
        strokeWidth={1}
        fill="none"
      />
    </Svg>
  );
}

export function Marker({
  children,
  coordinate,
  pinColor = statusColors.positive,
  title,
  description,
  identifier,
  onPress,
}: MarkerProps) {
  const preview = useMapPreview();
  const position = project(coordinate, preview.region);
  return (
    <Pressable
      style={[styles.markerWrap, { left: `${position.x}%`, top: `${position.y}%` }]}
      accessibilityLabel={`${title ?? "Map point"}, latitude ${coordinate.latitude}, longitude ${coordinate.longitude}${description ? `, ${description}` : ""}`}
      accessibilityRole="button"
      onPress={() => {
        preview.select(markerId({ identifier, title, coordinate }));
        onPress?.();
      }}
    >
      {children ?? <View style={[styles.marker, { backgroundColor: pinColor }]} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  zoomControls: { flexDirection: "row", gap: 8, padding: 8, backgroundColor: "#edf3ee" },
  zoomButton: { padding: 8, borderWidth: 1, borderColor: "#214034", borderRadius: 6 },
  preview: { minWidth: 0, maxWidth: "100%", overflow: "hidden" },
  inspection: {
    gap: 8,
    padding: 8,
    backgroundColor: "#edf3ee",
    minWidth: 0,
    maxHeight: "50%",
    flexGrow: 0,
  },
  details: { gap: 3, minWidth: 0 },
  map: {
    flex: 1,
    minHeight: 0,
    backgroundColor: "#d8e4dc",
    overflow: "hidden",
    position: "relative",
  },
  grid: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(255,255,255,0.28)",
  },
  markerWrap: {
    position: "absolute",
    width: 14,
    height: 14,
    transform: [{ translateX: -7 }, { translateY: -7 }],
    alignItems: "center",
    justifyContent: "center",
  },
  description: { color: "#214034", fontSize: 11, flexShrink: 1 },
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
    textAlign: "center",
  },
});
