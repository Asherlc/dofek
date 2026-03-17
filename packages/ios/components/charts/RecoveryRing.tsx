import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";

interface RecoveryRingProps {
  /** 0-100 readiness/recovery score */
  score: number;
  /** Size of the ring in dp */
  size?: number;
  /** Ring stroke width */
  strokeWidth?: number;
  /** Optional label below score */
  label?: string;
}

function scoreColor(score: number): string {
  if (score >= 67) return "#00E676"; // green - recovered
  if (score >= 34) return "#FFD600"; // yellow - moderate
  return "#FF3D00"; // red - poor recovery
}

function scoreLabel(score: number): string {
  if (score >= 67) return "Recovered";
  if (score >= 34) return "Moderate";
  return "Poor";
}

export function RecoveryRing({
  score,
  size = 200,
  strokeWidth = 14,
  label,
}: RecoveryRingProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.min(Math.max(score / 100, 0), 1);
  const strokeDashoffset = circumference * (1 - progress);
  const color = scoreColor(score);
  const center = size / 2;

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      <Svg width={size} height={size}>
        {/* Background track */}
        <Circle
          cx={center}
          cy={center}
          r={radius}
          stroke="#2a2a2e"
          strokeWidth={strokeWidth}
          fill="none"
        />
        {/* Progress arc */}
        <Circle
          cx={center}
          cy={center}
          r={radius}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          rotation={-90}
          origin={`${center}, ${center}`}
        />
      </Svg>
      <View style={styles.labelContainer}>
        <Text style={[styles.score, { color }]}>{Math.round(score)}</Text>
        <Text style={styles.sublabel}>{label ?? scoreLabel(score)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
  },
  labelContainer: {
    position: "absolute",
    alignItems: "center",
  },
  score: {
    fontSize: 48,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
  },
  sublabel: {
    fontSize: 14,
    color: "#8e8e93",
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
});
