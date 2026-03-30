import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { colors, duration, radius } from "../theme";

/**
 * Skeleton loading primitives with shimmer animation.
 *
 * Uses react-native-reanimated opacity pulse to create a shimmer effect
 * matching the web UI's animated skeleton loading pattern.
 */

function useShimmer() {
  const opacity = useSharedValue(0.3);

  useEffect(() => {
    opacity.value = withRepeat(withTiming(0.7, { duration: duration.chart }), -1, true);
  }, [opacity]);

  return useAnimatedStyle(() => ({ opacity: opacity.value }));
}

/** Circular skeleton placeholder (for ring/gauge loading states) */
export function SkeletonCircle({ size }: { size: number }) {
  const shimmerStyle = useShimmer();

  return (
    <Animated.View
      testID="skeleton-circle"
      style={[
        styles.base,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
        },
        shimmerStyle,
      ]}
    />
  );
}

/** Rectangular skeleton placeholder (for text lines, bars) */
export function SkeletonRect({
  width,
  height,
  borderRadiusOverride,
}: {
  width: number | string;
  height: number;
  borderRadiusOverride?: number;
}) {
  const shimmerStyle = useShimmer();

  return (
    <Animated.View
      testID="skeleton-rect"
      style={[
        styles.base,
        {
          width,
          height,
          borderRadius: borderRadiusOverride ?? radius.sm,
        },
        shimmerStyle,
      ]}
    />
  );
}

/** Full card skeleton matching the Card component dimensions */
export function SkeletonCard() {
  const shimmerStyle = useShimmer();

  return (
    <View testID="skeleton-card" style={styles.card}>
      <Animated.View style={[styles.cardLine1, shimmerStyle]} />
      <Animated.View style={[styles.cardLine2, shimmerStyle]} />
      <Animated.View style={[styles.cardLine3, shimmerStyle]} />
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: colors.surfaceSecondary,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: 16,
    gap: 12,
    height: 120,
  },
  cardLine1: {
    width: "40%",
    height: 12,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSecondary,
  },
  cardLine2: {
    width: "70%",
    height: 24,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSecondary,
  },
  cardLine3: {
    width: "50%",
    height: 12,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSecondary,
  },
});
