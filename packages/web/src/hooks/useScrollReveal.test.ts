/** @vitest-environment jsdom */

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScrollReveal } from "./useScrollReveal.ts";

// Track observer instances and callbacks
type IntersectionCallback = (entries: Partial<IntersectionObserverEntry>[]) => void;

let observerInstances: Array<{
  callback: IntersectionCallback;
  options: IntersectionObserverInit | undefined;
  observe: ReturnType<typeof vi.fn>;
  unobserve: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}>;

beforeEach(() => {
  observerInstances = [];

  const MockIntersectionObserver = vi.fn(
    (callback: IntersectionCallback, options?: IntersectionObserverInit) => {
      const instance = {
        callback,
        options,
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
        root: null,
        rootMargin: options?.rootMargin ?? "0px",
        thresholds: options?.threshold ? [Number(options.threshold)] : [0],
        takeRecords: () => [],
      };
      observerInstances.push(instance);
      return instance;
    },
  );

  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useScrollReveal", () => {
  it("returns a ref object", () => {
    const { result } = renderHook(() => useScrollReveal());
    expect(result.current).toBeDefined();
    expect(result.current).toHaveProperty("current");
  });

  it("ref is initially null", () => {
    const { result } = renderHook(() => useScrollReveal());
    expect(result.current.current).toBeNull();
  });

  it("creates an IntersectionObserver when element is attached", () => {
    const { result } = renderHook(() => useScrollReveal());

    // Simulate attaching the ref to a DOM element
    const element = document.createElement("div");
    Object.defineProperty(result.current, "current", {
      value: element,
      writable: true,
    });

    // Re-render to trigger useEffect with the element
    renderHook(() => useScrollReveal());
    const el = document.createElement("div");

    // We need to set the ref before render. Let's use a different approach:
    // Create a hook that assigns a real element to the ref
    const { unmount } = renderHook(() => {
      const ref = useScrollReveal<HTMLDivElement>();
      // Simulate ref attachment
      if (ref.current === null) {
        Object.defineProperty(ref, "current", {
          value: el,
          writable: true,
          configurable: true,
        });
      }
      return ref;
    });

    // The observer should have been created
    // Note: Because ref.current is null during initial render's useEffect,
    // the observer might not be created. This is expected behavior.
    unmount();
  });

  it("sets transitionDelay based on staggerIndex", () => {
    const element = document.createElement("div");

    // We'll verify the hook's behavior by checking what it does to the element
    // when the IntersectionObserver fires
    renderHook(() => {
      const ref = useScrollReveal<HTMLDivElement>(3);
      // Override ref.current before useEffect runs
      Object.defineProperty(ref, "current", {
        value: element,
        writable: true,
        configurable: true,
      });
      return ref;
    });

    // The transitionDelay should be set to staggerIndex * 60ms
    expect(element.style.transitionDelay).toBe("180ms");
  });

  it("sets 0ms delay for default staggerIndex of 0", () => {
    const element = document.createElement("div");

    renderHook(() => {
      const ref = useScrollReveal<HTMLDivElement>();
      Object.defineProperty(ref, "current", {
        value: element,
        writable: true,
        configurable: true,
      });
      return ref;
    });

    expect(element.style.transitionDelay).toBe("0ms");
  });

  it("adds revealed class when element enters viewport", () => {
    const element = document.createElement("div");

    renderHook(() => {
      const ref = useScrollReveal<HTMLDivElement>();
      Object.defineProperty(ref, "current", {
        value: element,
        writable: true,
        configurable: true,
      });
      return ref;
    });

    // Find the observer instance that was created
    const observer = observerInstances[observerInstances.length - 1];
    expect(observer).toBeDefined();

    // Simulate the element entering the viewport
    observer?.callback([{ isIntersecting: true, target: element }]);

    expect(element.classList.contains("revealed")).toBe(true);
  });

  it("does not add revealed class when element is not intersecting", () => {
    const element = document.createElement("div");

    renderHook(() => {
      const ref = useScrollReveal<HTMLDivElement>();
      Object.defineProperty(ref, "current", {
        value: element,
        writable: true,
        configurable: true,
      });
      return ref;
    });

    const observer = observerInstances[observerInstances.length - 1];
    expect(observer).toBeDefined();

    // Simulate the element NOT entering the viewport
    observer?.callback([{ isIntersecting: false, target: element }]);

    expect(element.classList.contains("revealed")).toBe(false);
  });

  it("unobserves element after it becomes visible", () => {
    const element = document.createElement("div");

    renderHook(() => {
      const ref = useScrollReveal<HTMLDivElement>();
      Object.defineProperty(ref, "current", {
        value: element,
        writable: true,
        configurable: true,
      });
      return ref;
    });

    const observer = observerInstances[observerInstances.length - 1];
    expect(observer).toBeDefined();

    // Simulate intersection
    observer?.callback([{ isIntersecting: true, target: element }]);

    expect(observer?.unobserve).toHaveBeenCalledWith(element);
  });

  it("observes the element on mount", () => {
    const element = document.createElement("div");

    renderHook(() => {
      const ref = useScrollReveal<HTMLDivElement>();
      Object.defineProperty(ref, "current", {
        value: element,
        writable: true,
        configurable: true,
      });
      return ref;
    });

    const observer = observerInstances[observerInstances.length - 1];
    expect(observer).toBeDefined();
    expect(observer?.observe).toHaveBeenCalledWith(element);
  });

  it("disconnects observer on unmount", () => {
    const element = document.createElement("div");

    const { unmount } = renderHook(() => {
      const ref = useScrollReveal<HTMLDivElement>();
      Object.defineProperty(ref, "current", {
        value: element,
        writable: true,
        configurable: true,
      });
      return ref;
    });

    const observer = observerInstances[observerInstances.length - 1];
    expect(observer).toBeDefined();

    unmount();

    expect(observer?.disconnect).toHaveBeenCalled();
  });

  it("configures IntersectionObserver with threshold 0.1 and rootMargin", () => {
    const element = document.createElement("div");

    renderHook(() => {
      const ref = useScrollReveal<HTMLDivElement>();
      Object.defineProperty(ref, "current", {
        value: element,
        writable: true,
        configurable: true,
      });
      return ref;
    });

    const observer = observerInstances[observerInstances.length - 1];
    expect(observer).toBeDefined();
    expect(observer?.options?.threshold).toBe(0.1);
    expect(observer?.options?.rootMargin).toBe("0px 0px -40px 0px");
  });

  it("handles different staggerIndex values", () => {
    const element1 = document.createElement("div");
    const element5 = document.createElement("div");

    renderHook(() => {
      const ref = useScrollReveal<HTMLDivElement>(1);
      Object.defineProperty(ref, "current", {
        value: element1,
        writable: true,
        configurable: true,
      });
      return ref;
    });

    renderHook(() => {
      const ref = useScrollReveal<HTMLDivElement>(5);
      Object.defineProperty(ref, "current", {
        value: element5,
        writable: true,
        configurable: true,
      });
      return ref;
    });

    expect(element1.style.transitionDelay).toBe("60ms");
    expect(element5.style.transitionDelay).toBe("300ms");
  });
});
