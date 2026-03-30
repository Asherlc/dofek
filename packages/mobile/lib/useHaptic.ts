import { useCallback, useRef } from "react";
import {
  ImpactFeedbackStyle,
  NotificationFeedbackType,
  impactAsync,
  notificationAsync,
  selectionAsync,
} from "expo-haptics";

const THROTTLE_MS = 150;

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
    fn().catch(() => {
      // Haptics unavailable — silently ignore (simulator, low power mode)
    });
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
