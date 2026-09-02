import type { ComponentType, ReactNode } from "react";
import { View } from "react-native";

interface AnimatedViewProps {
  children?: ReactNode;
  style?: unknown;
  testID?: string;
}

function AnimatedView({ children, style, testID, ...props }: AnimatedViewProps) {
  return (
    <View {...props} style={style} testID={testID}>
      {children}
    </View>
  );
}

function chainableAnimation() {
  return {
    delay: () => chainableAnimation(),
    duration: () => chainableAnimation(),
    easing: () => chainableAnimation(),
  };
}

const animated = {
  View: AnimatedView,
  createAnimatedComponent: <ComponentProps,>(component: ComponentType<ComponentProps>) => component,
};

export default animated;

export function createAnimatedComponent<ComponentProps>(component: ComponentType<ComponentProps>) {
  return component;
}

export function useSharedValue<T>(initial: T): { value: T } {
  return { value: initial };
}

export function useAnimatedProps<T>(updater: () => T): T {
  return updater();
}

export function useAnimatedStyle<T>(updater: () => T): T {
  return updater();
}

export function withTiming<T>(toValue: T): T {
  return toValue;
}

export function withDelay<T>(_delayMs: number, animation: T): T {
  return animation;
}

export function withRepeat<T>(animation: T): T {
  return animation;
}

export function withSpring<T>(toValue: T): T {
  return toValue;
}

export function runOnJS<Callback extends (...args: unknown[]) => unknown>(callback: Callback) {
  return callback;
}

export const Easing = {
  bezier: () => ({}),
  linear: {},
  ease: {},
  out: () => ({}),
  in: () => ({}),
  inOut: () => ({}),
};

export const FadeIn = chainableAnimation();
export const FadeInUp = chainableAnimation();
export const FadeOut = chainableAnimation();
export const SlideInRight = chainableAnimation();
export const Layout = { duration: () => ({}) };
