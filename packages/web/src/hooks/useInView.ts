import { useEffect, useRef, useState } from "react";

/**
 * Returns a ref and a boolean indicating whether the element has entered the viewport.
 * Once triggered, stays true (no re-hiding) so queries don't re-fire.
 */
export function useInView(rootMargin = "200px") {
  const ref = useRef<HTMLDivElement>(null);
  const [hasBeenVisible, setHasBeenVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || hasBeenVisible) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setHasBeenVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [hasBeenVisible, rootMargin]);

  return { ref, hasBeenVisible } as const;
}
