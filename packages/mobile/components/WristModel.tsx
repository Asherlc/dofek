import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Circle, Line, Text as SvgText } from "react-native-svg";
import type { OrientationEvent } from "../modules/whoop-ble";
import { colors } from "../theme";

/** 3D vertex: [x, y, z] */
type Vertex = [number, number, number];

/** Edge connecting two vertex indices */
type Edge = [number, number];

/**
 * WHOOP strap dimensions (mm, used as relative proportions).
 * The strap sensor module is roughly a flat rectangle.
 */
const STRAP_WIDTH = 44;
const STRAP_HEIGHT = 30;
const STRAP_DEPTH = 12;

/** Half-dimensions for centering at origin */
const halfWidth = STRAP_WIDTH / 2;
const halfHeight = STRAP_HEIGHT / 2;
const halfDepth = STRAP_DEPTH / 2;

/** Labeled vertex for stable React keys */
interface LabeledVertex {
  label: string;
  coords: Vertex;
}

/** 8 vertices of a rectangular prism centered at origin */
const labeledVertices: LabeledVertex[] = [
  { label: "bbl", coords: [-halfWidth, -halfHeight, -halfDepth] },
  { label: "bbr", coords: [halfWidth, -halfHeight, -halfDepth] },
  { label: "btr", coords: [halfWidth, halfHeight, -halfDepth] },
  { label: "btl", coords: [-halfWidth, halfHeight, -halfDepth] },
  { label: "fbl", coords: [-halfWidth, -halfHeight, halfDepth] },
  { label: "fbr", coords: [halfWidth, -halfHeight, halfDepth] },
  { label: "ftr", coords: [halfWidth, halfHeight, halfDepth] },
  { label: "ftl", coords: [-halfWidth, halfHeight, halfDepth] },
];

/** 12 edges of the rectangular prism */
const edges: Edge[] = [
  // Back face
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  // Front face
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  // Connecting edges
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

/** Axis indicator length (in model units) */
const AXIS_LENGTH = 35;

/** Axis indicator vertices: [origin, X endpoint, Y endpoint, Z endpoint] */
const axisOrigin: Vertex = [0, 0, 0];
const axisEndX: Vertex = [AXIS_LENGTH, 0, 0];
const axisEndY: Vertex = [0, AXIS_LENGTH, 0];
const axisEndZ: Vertex = [0, 0, AXIS_LENGTH];

/** Rotate a vertex by a quaternion */
function rotateByQuaternion(vertex: Vertex, quaternion: OrientationEvent): Vertex {
  const [vx, vy, vz] = vertex;
  const { w, x, y, z } = quaternion;

  // q * v * q^-1 (Hamilton product, optimized)
  const ix = w * vx + y * vz - z * vy;
  const iy = w * vy + z * vx - x * vz;
  const iz = w * vz + x * vy - y * vx;
  const iw = -x * vx - y * vy - z * vz;

  return [
    ix * w - iw * x - iy * z + iz * y,
    iy * w - iw * y - iz * x + ix * z,
    iz * w - iw * z - ix * y + iy * x,
  ];
}

/** Isometric projection: 3D → 2D with a slight perspective tilt */
function project(
  vertex: Vertex,
  scale: number,
  centerX: number,
  centerY: number,
): [number, number] {
  const [x, y, z] = vertex;
  // Simple oblique projection with a tilt for depth perception
  const projectedX = centerX + (x + z * 0.3) * scale;
  const projectedY = centerY - (y + z * 0.15) * scale;
  return [projectedX, projectedY];
}

interface WristModelProps {
  /** Current orientation from the Madgwick filter */
  orientation: OrientationEvent;
  /** SVG viewport size */
  size?: number;
}

/**
 * 3D wireframe rendering of the WHOOP strap orientation.
 *
 * Rotates a rectangular prism using the quaternion from the Madgwick AHRS
 * filter and projects it to 2D using oblique projection. Includes XYZ
 * axis indicators for reference.
 */
export function WristModel({ orientation, size = 250 }: WristModelProps) {
  const scale = size / 120;
  const center = size / 2;

  const projected = useMemo(() => {
    // Rotate and project all box vertices
    const boxPoints = labeledVertices.map(({ label, coords }) => {
      const rotated = rotateByQuaternion(coords, orientation);
      return { label, point: project(rotated, scale, center, center) };
    });

    // Rotate and project axis indicator vertices (origin, X, Y, Z)
    const rotatedOrigin = rotateByQuaternion(axisOrigin, orientation);
    const rotatedAxisX = rotateByQuaternion(axisEndX, orientation);
    const rotatedAxisY = rotateByQuaternion(axisEndY, orientation);
    const rotatedAxisZ = rotateByQuaternion(axisEndZ, orientation);

    return {
      boxPoints,
      origin: project(rotatedOrigin, scale, center, center),
      axisX: project(rotatedAxisX, scale, center, center),
      axisY: project(rotatedAxisY, scale, center, center),
      axisZ: project(rotatedAxisZ, scale, center, center),
    };
  }, [orientation, scale, center]);

  return (
    <View style={styles.container}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Axis indicators */}
        <Line
          x1={projected.origin[0]}
          y1={projected.origin[1]}
          x2={projected.axisX[0]}
          y2={projected.axisX[1]}
          stroke={colors.danger}
          strokeWidth={2}
          opacity={0.7}
        />
        <SvgText
          x={projected.axisX[0]}
          y={projected.axisX[1]}
          fill={colors.danger}
          fontSize={12}
          fontWeight="bold"
        >
          X
        </SvgText>
        <Line
          x1={projected.origin[0]}
          y1={projected.origin[1]}
          x2={projected.axisY[0]}
          y2={projected.axisY[1]}
          stroke={colors.green}
          strokeWidth={2}
          opacity={0.7}
        />
        <SvgText
          x={projected.axisY[0]}
          y={projected.axisY[1]}
          fill={colors.green}
          fontSize={12}
          fontWeight="bold"
        >
          Y
        </SvgText>
        <Line
          x1={projected.origin[0]}
          y1={projected.origin[1]}
          x2={projected.axisZ[0]}
          y2={projected.axisZ[1]}
          stroke={colors.blue}
          strokeWidth={2}
          opacity={0.7}
        />
        <SvgText
          x={projected.axisZ[0]}
          y={projected.axisZ[1]}
          fill={colors.blue}
          fontSize={12}
          fontWeight="bold"
        >
          Z
        </SvgText>

        {/* Wireframe box edges */}
        {edges.map((edge) => {
          const [startIndex, endIndex] = edge;
          const start = projected.boxPoints[startIndex];
          const end = projected.boxPoints[endIndex];
          if (!start || !end) return null;
          return (
            <Line
              key={`${startIndex}-${endIndex}`}
              x1={start.point[0]}
              y1={start.point[1]}
              x2={end.point[0]}
              y2={end.point[1]}
              stroke={colors.accent}
              strokeWidth={2}
            />
          );
        })}

        {/* Vertex dots */}
        {projected.boxPoints.map(({ label, point }) => (
          <Circle key={label} cx={point[0]} cy={point[1]} r={3} fill={colors.accent} />
        ))}

        {/* Origin dot */}
        <Circle cx={projected.origin[0]} cy={projected.origin[1]} r={4} fill={colors.text} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
  },
});
