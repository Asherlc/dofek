import { useEffect, useRef, useState } from "react";

/**
 * Animates a number from 0 to the target value with ease-out easing.
 * Returns the current animated value.
 *
 * @param target - The final value to animate to
 * @param duration - Animation duration in ms (default 800)
 * @param decimals - Number of decimal places (default 0)
 */
export function useCountUp(
  target: number | null | undefined,
  duration = 800,
  decimals = 0,
): string {
  const [display, setDisplay] = useState("—");
  const prevTarget = useRef<number | null>(null);
  const rafId = useRef<number>(0);

  useEffect(() => {
    if (target == null) {
      setDisplay("—");
      prevTarget.current = null;
      return;
    }

    const from = prevTarget.current ?? 0;
    const to = target;
    prevTarget.current = to;

    const startTime = performance.now();

    function tick(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out cubic
      const eased = 1 - (1 - progress) ** 3;
      const current = from + (to - from) * eased;

      if (decimals === 0) {
        setDisplay(Math.round(current).toLocaleString());
      } else {
        setDisplay(current.toFixed(decimals));
      }

      if (progress < 1) {
        rafId.current = requestAnimationFrame(tick);
      }
    }

    rafId.current = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rafId.current);
  }, [target, duration, decimals]);

  return display;
}
