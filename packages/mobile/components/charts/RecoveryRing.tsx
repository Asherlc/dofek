import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  Easing,
  createAnimatedComponent,
  useAnimatedProps,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";
import { scoreColor, scoreLabel } from "../../lib/scoring";
import { colors, duration } from "../../theme";

const AnimatedCircle = createAnimatedComponent(Circle);

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

export function RecoveryRing({ score, size = 200, strokeWidth = 14, label }: RecoveryRingProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.min(Math.max(score / 100, 0), 1);
  const targetOffset = circumference * (1 - progress);
  const color = scoreColor(score);
  const center = size / 2;

  const animatedOffset = useSharedValue(circumference);

  useEffect(() => {
    animatedOffset.value = withTiming(targetOffset, {
      duration: duration.chart,
      easing: Easing.bezier(0.16, 1, 0.3, 1),
    });
  }, [targetOffset, animatedOffset, circumference]);

  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: animatedOffset.value,
  }));

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      <Svg width={size} height={size}>
        {/* Background track */}
        <Circle
          cx={center}
          cy={center}
          r={radius}
          stroke={colors.surfaceSecondary}
          strokeWidth={strokeWidth}
          fill="none"
        />
        {/* Animated progress arc */}
        <AnimatedCircle
          cx={center}
          cy={center}
          r={radius}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          strokeDasharray={circumference}
          strokeLinecap="round"
          rotation={-90}
          origin={`${center}, ${center}`}
          animatedProps={animatedProps}
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
    color: colors.textSecondary,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
});
