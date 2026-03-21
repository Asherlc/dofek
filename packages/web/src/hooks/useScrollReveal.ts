import { type RefObject, useEffect, useRef } from "react";

/**
 * Triggers a CSS class when the element enters the viewport.
 * Cards start invisible and slide up with a staggered delay.
 *
 * Usage:
 * ```tsx
 * const ref = useScrollReveal<HTMLDivElement>();
 * <div ref={ref} className="reveal" />
 * ```
 *
 * Requires these CSS classes in index.css:
 * .reveal { opacity: 0; transform: translateY(12px); transition: ... }
 * .reveal.revealed { opacity: 1; transform: translateY(0); }
 */
export function useScrollReveal<T extends HTMLElement>(staggerIndex = 0): RefObject<T | null> {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Set stagger delay via CSS custom property
    el.style.transitionDelay = `${staggerIndex * 60}ms`;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          el.classList.add("revealed");
          observer.unobserve(el);
        }
      },
      { threshold: 0.1, rootMargin: "0px 0px -40px 0px" },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [staggerIndex]);

  return ref;
}
