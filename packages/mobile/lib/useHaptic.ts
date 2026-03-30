import {
  ImpactFeedbackStyle,
  impactAsync,
  NotificationFeedbackType,
  notificationAsync,
  selectionAsync,
} from "expo-haptics";
import { useCallback, useRef } from "react";

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
    fn().catch((_error: unknown) => {
      // Haptics unavailable — intentionally ignored (simulator, low power mode).
      // This is non-critical UI feedback; logging would just create noise.
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
