import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Circle, Polygon } from "react-native-svg";
import type { OrientationEvent } from "../modules/whoop-ble";

type Vec3 = [number, number, number];

interface Face {
  indices: number[];
  baseColor: [number, number, number];
}

/* ── geometry constants ──────────────────────────────────── */
const SEGMENTS = 24;
const RING_RADIUS = 24;
const BAND_WIDTH = 9;
const BAND_THICKNESS = 2.5;
const POD_ARC = 5;
const POD_WIDTH = 12;
const POD_HEIGHT = 5.5;

/* ── WHOOP-inspired dark palette ─────────────────────────── */
const BAND_OUTER: [number, number, number] = [35, 35, 38];
const BAND_INNER: [number, number, number] = [22, 22, 24];
const BAND_EDGE: [number, number, number] = [28, 28, 30];
const POD_OUTER: [number, number, number] = [48, 48, 52];
const POD_SIDE: [number, number, number] = [38, 38, 42];
const POD_CAP: [number, number, number] = [42, 42, 46];

/* ── generate mesh once at module load ───────────────────── */
function buildMesh(): { vertices: Vec3[]; faces: Face[] } {
  const vertices: Vec3[] = [];
  const faces: Face[] = [];
  const halfBandWidth = BAND_WIDTH / 2;
  const rInner = RING_RADIUS - BAND_THICKNESS / 2;
  const rOuter = RING_RADIUS + BAND_THICKNESS / 2;

  // Band ring (around Y axis, cross-section in X-Z plane)
  for (let segment = 0; segment <= SEGMENTS; segment++) {
    const theta = (segment / SEGMENTS) * Math.PI * 2;
    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);
    vertices.push(
      [rInner * cosTheta, -halfBandWidth, rInner * sinTheta], // inner-left
      [rInner * cosTheta, halfBandWidth, rInner * sinTheta], // inner-right
      [rOuter * cosTheta, -halfBandWidth, rOuter * sinTheta], // outer-left
      [rOuter * cosTheta, halfBandWidth, rOuter * sinTheta], // outer-right
    );
  }

  for (let segment = 0; segment < SEGMENTS; segment++) {
    const current = segment * 4;
    const next = (segment + 1) * 4;
    faces.push(
      { indices: [current + 2, next + 2, next + 3, current + 3], baseColor: BAND_OUTER },
      { indices: [current + 1, next + 1, next + 0, current + 0], baseColor: BAND_INNER },
      { indices: [current + 0, next + 0, next + 2, current + 2], baseColor: BAND_EDGE },
      { indices: [current + 3, next + 3, next + 1, current + 1], baseColor: BAND_EDGE },
    );
  }

  // Sensor pod (on band outer surface, centered at theta=0)
  const podBase = vertices.length;
  const podHalfWidth = POD_WIDTH / 2;
  const podOuterRadius = rOuter + POD_HEIGHT;

  for (let segment = 0; segment <= POD_ARC; segment++) {
    const theta = ((segment - POD_ARC / 2) / SEGMENTS) * Math.PI * 2;
    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);
    vertices.push(
      [rOuter * cosTheta, -podHalfWidth, rOuter * sinTheta],
      [rOuter * cosTheta, podHalfWidth, rOuter * sinTheta],
      [podOuterRadius * cosTheta, -podHalfWidth, podOuterRadius * sinTheta],
      [podOuterRadius * cosTheta, podHalfWidth, podOuterRadius * sinTheta],
    );
  }

  for (let segment = 0; segment < POD_ARC; segment++) {
    const current = podBase + segment * 4;
    const next = podBase + (segment + 1) * 4;
    faces.push(
      { indices: [current + 2, next + 2, next + 3, current + 3], baseColor: POD_OUTER },
      { indices: [current + 1, next + 1, next + 0, current + 0], baseColor: POD_SIDE },
      { indices: [current + 0, next + 0, next + 2, current + 2], baseColor: POD_SIDE },
      { indices: [current + 3, next + 3, next + 1, current + 1], baseColor: POD_SIDE },
    );
  }

  // Pod end caps
  const podFirst = podBase;
  const podLast = podBase + POD_ARC * 4;
  faces.push(
    { indices: [podFirst + 0, podFirst + 2, podFirst + 3, podFirst + 1], baseColor: POD_CAP },
    { indices: [podLast + 1, podLast + 3, podLast + 2, podLast + 0], baseColor: POD_CAP },
  );

  return { vertices, faces };
}

const MESH = buildMesh();

/* ── light direction (normalized) ────────────────────────── */
const LIGHT_DIRECTION: Vec3 = (() => {
  const raw: Vec3 = [0.3, 0.6, 0.75];
  const length = Math.hypot(...raw);
  return [raw[0] / length, raw[1] / length, raw[2] / length];
})();

/* ── LED position (center of pod top surface) ────────────── */
const LED_POSITION: Vec3 = [RING_RADIUS + BAND_THICKNESS / 2 + POD_HEIGHT * 0.75, 0, 0];

/* ── math helpers ────────────────────────────────────────── */
function rotateByQuaternion(vertex: Vec3, quaternion: OrientationEvent): Vec3 {
  const [vx, vy, vz] = vertex;
  const { w, x, y, z } = quaternion;
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

function crossProduct(edgeA: Vec3, edgeB: Vec3): Vec3 {
  return [
    edgeA[1] * edgeB[2] - edgeA[2] * edgeB[1],
    edgeA[2] * edgeB[0] - edgeA[0] * edgeB[2],
    edgeA[0] * edgeB[1] - edgeA[1] * edgeB[0],
  ];
}

function normalizeVec(vector: Vec3): Vec3 {
  const length = Math.hypot(...vector);
  return length > 0 ? [vector[0] / length, vector[1] / length, vector[2] / length] : [0, 0, 0];
}

function dotProduct(vectorA: Vec3, vectorB: Vec3): number {
  return vectorA[0] * vectorB[0] + vectorA[1] * vectorB[1] + vectorA[2] * vectorB[2];
}

function computeFaceNormal(vertices: Vec3[]): Vec3 {
  const origin = vertices[0];
  const second = vertices[1];
  const third = vertices[2];
  if (!origin || !second || !third) return [0, 0, 1];
  const edgeA: Vec3 = [second[0] - origin[0], second[1] - origin[1], second[2] - origin[2]];
  const edgeB: Vec3 = [third[0] - origin[0], third[1] - origin[1], third[2] - origin[2]];
  return normalizeVec(crossProduct(edgeA, edgeB));
}

/* ── component ───────────────────────────────────────────── */
interface WristModelProps {
  /** Current orientation from the Madgwick filter */
  orientation: OrientationEvent;
  /** SVG viewport size */
  size?: number;
}

/**
 * 3D solid rendering of a WHOOP band.
 *
 * Renders a circular wristband with a raised sensor pod, rotated by the
 * quaternion from the Madgwick AHRS filter. Uses painter's algorithm
 * (depth-sorted filled polygons) with directional lighting for a solid 3D look.
 */
export function WristModel({ orientation, size = 280 }: WristModelProps) {
  const scale = size / 82;
  const centerX = size / 2;
  const centerY = size / 2;

  const scene = useMemo(() => {
    // Rotate all vertices by current orientation
    const rotated = MESH.vertices.map((vertex) => rotateByQuaternion(vertex, orientation));

    // Oblique projection (3D → 2D)
    const projectVertex = (vertex: Vec3): [number, number] => [
      centerX + (vertex[0] + vertex[2] * 0.35) * scale,
      centerY - (vertex[1] + vertex[2] * 0.2) * scale,
    ];
    const projected = rotated.map(projectVertex);

    // Build renderable faces with depth and lighting
    const rendered: { key: number; points: string; fill: string; depth: number }[] = [];

    for (const [faceIndex, face] of MESH.faces.entries()) {
      // Resolve vertices in world and screen space
      const worldVerts: Vec3[] = [];
      const screenVerts: [number, number][] = [];
      for (const vertexIndex of face.indices) {
        const worldVertex = rotated[vertexIndex];
        const screenVertex = projected[vertexIndex];
        if (!worldVertex || !screenVertex) continue;
        worldVerts.push(worldVertex);
        screenVerts.push(screenVertex);
      }
      if (worldVerts.length < 3 || screenVerts.length < 3) continue;

      // Average Z for painter's algorithm
      const averageDepth =
        worldVerts.reduce((sum, vertex) => sum + vertex[2], 0) / worldVerts.length;

      // Face normal for lighting
      const faceNormal = computeFaceNormal(worldVerts);

      // Ambient + diffuse lighting (abs for two-sided faces)
      const diffuse = Math.abs(dotProduct(faceNormal, LIGHT_DIRECTION));
      const brightness = 0.35 + diffuse * 0.65;

      const [red, green, blue] = face.baseColor;
      const fill = `rgb(${Math.round(red * brightness)},${Math.round(green * brightness)},${Math.round(blue * brightness)})`;

      rendered.push({
        key: faceIndex,
        points: screenVerts
          .map((point) => `${point[0].toFixed(1)},${point[1].toFixed(1)}`)
          .join(" "),
        fill,
        depth: averageDepth,
      });
    }

    // Painter's algorithm: draw farthest faces first
    rendered.sort((faceA, faceB) => faceA.depth - faceB.depth);

    // Project the LED indicator position
    const ledScreenPos = projectVertex(rotateByQuaternion(LED_POSITION, orientation));

    return { faces: rendered, led: ledScreenPos };
  }, [orientation, scale, centerX, centerY]);

  return (
    <View style={styles.container}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {scene.faces.map((face) => (
          <Polygon
            key={face.key}
            points={face.points}
            fill={face.fill}
            stroke="rgba(50,50,55,0.2)"
            strokeWidth={0.3}
          />
        ))}
        {/* Green LED glow on sensor pod */}
        <Circle cx={scene.led[0]} cy={scene.led[1]} r={5} fill="#00e676" opacity={0.15} />
        <Circle cx={scene.led[0]} cy={scene.led[1]} r={2.5} fill="#00e676" opacity={0.8} />
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
