import type { ReactNode } from "react";
import Animated, { FadeInUp, Easing } from "react-native-reanimated";
import { Card } from "./Card";
import { duration } from "../theme";

const STAGGER_DELAY = 80;

interface AnimatedCardProps {
  children: ReactNode;
  /** Stagger index — cards animate in sequentially */
  index: number;
  /** Optional uppercase section title */
  title?: string;
}

export function AnimatedCard({ children, index, title }: AnimatedCardProps) {
  return (
    <Animated.View
      entering={FadeInUp.delay(index * STAGGER_DELAY)
        .duration(duration.slow)
        .easing(Easing.bezier(0.16, 1, 0.3, 1))}
    >
      <Card title={title}>{children}</Card>
    </Animated.View>
  );
}
