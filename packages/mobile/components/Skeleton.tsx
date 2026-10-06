import { useEffect } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { colors, duration } from "../theme";

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

const styles = StyleSheet.create({
  base: {
    backgroundColor: colors.surfaceSecondary,
  },
});
