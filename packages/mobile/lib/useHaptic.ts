import {
  ImpactFeedbackStyle,
  impactAsync,
  NotificationFeedbackType,
  notificationAsync,
  selectionAsync,
} from "expo-haptics";
import { useCallback, useRef } from "react";

const THROTTLE_MS = 150;

type OptionalHapticResult = { status: "performed" } | { status: "unavailable"; cause: unknown };

async function performOptionalHaptic(
  operation: () => Promise<void>,
): Promise<OptionalHapticResult> {
  try {
    await operation();
    return { status: "performed" };
  } catch (cause: unknown) {
    return { status: "unavailable", cause };
  }
}

/**
 * Haptic feedback hook with built-in throttling.
 *
 * Prevents rapid-fire haptics from degrading the Taptic Engine response.
 * Gracefully no-ops if haptics aren't available (e.g. simulator, low power mode).
 */
export function useHaptic() {
  const lastFired = useRef(0);

  const throttled = useCallback((fn: () => Promise<void>) => {
    const now = Date.now();
    if (now - lastFired.current < THROTTLE_MS) return;
    lastFired.current = now;
    void performOptionalHaptic(fn);
  }, []);

  const selection = useCallback(() => {
    throttled(selectionAsync);
  }, [throttled]);

  const impact = useCallback(
    (style: ImpactFeedbackStyle = ImpactFeedbackStyle.Light) => {
      throttled(() => impactAsync(style));
    },
    [throttled],
  );

  const notification = useCallback(
    (type: NotificationFeedbackType = NotificationFeedbackType.Success) => {
      throttled(() => notificationAsync(type));
    },
    [throttled],
  );

  return { selection, impact, notification };
}
