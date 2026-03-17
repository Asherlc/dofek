import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { colors } from "../../theme";

interface StrainGaugeProps {
  /** Daily strain/load value */
  strain: number;
  /** Max strain for scaling (default 21 like Whoop) */
  maxStrain?: number;
  /** Size in dp */
  size?: number;
}

function strainColor(fraction: number): string {
  if (fraction >= 0.75) return colors.accent; // high strain - blue
  if (fraction >= 0.5) return colors.teal; // medium-high
  if (fraction >= 0.25) return colors.green; // moderate
  return colors.textSecondary; // light
}

export function StrainGauge({
  strain,
  maxStrain = 21,
  size = 120,
}: StrainGaugeProps) {
  const strokeWidth = 10;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = Math.min(strain / maxStrain, 1);
  const strokeDashoffset = circumference * (1 - fraction);
  const color = strainColor(fraction);
  const center = size / 2;

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      <Svg width={size} height={size}>
        <Circle
          cx={center}
          cy={center}
          r={radius}
          stroke={colors.surfaceSecondary}
          strokeWidth={strokeWidth}
          fill="none"
        />
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
        <Text style={[styles.value, { color }]}>{strain.toFixed(1)}</Text>
        <Text style={styles.label}>Strain</Text>
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
  value: {
    fontSize: 24,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
  },
  label: {
    fontSize: 11,
    color: colors.textSecondary,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
});
