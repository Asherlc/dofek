import { StyleSheet, View } from "react-native";
import { colors, radius } from "../theme";

/**
 * Skeleton loading primitives.
 *
 * Uses simple static styles instead of animated shimmer — the pulse
 * animation will be added in a later phase when reanimated's test
 * compatibility is more robust. Static skeletons still provide a
 * significantly better UX than "Loading..." text.
 */

/** Circular skeleton placeholder (for ring/gauge loading states) */
export function SkeletonCircle({ size }: { size: number }) {
  return (
    <View
      testID="skeleton-circle"
      style={[
        styles.base,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
        },
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
  return (
    <View
      testID="skeleton-rect"
      style={[
        styles.base,
        {
          width,
          height,
          borderRadius: borderRadiusOverride ?? radius.sm,
        },
      ]}
    />
  );
}

/** Full card skeleton matching the Card component dimensions */
export function SkeletonCard() {
  return (
    <View testID="skeleton-card" style={styles.card}>
      <View style={styles.cardLine1} />
      <View style={styles.cardLine2} />
      <View style={styles.cardLine3} />
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: colors.surfaceSecondary,
    opacity: 0.5,
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
    opacity: 0.5,
  },
  cardLine2: {
    width: "70%",
    height: 24,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSecondary,
    opacity: 0.5,
  },
  cardLine3: {
    width: "50%",
    height: 12,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSecondary,
    opacity: 0.5,
  },
});
