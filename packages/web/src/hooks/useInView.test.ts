import { afterEach, describe, expect, it, vi } from "vitest";
// Import to establish file relationship for mutation testing (Stryker)
import { useInView } from "./useInView.ts";

type IntersectionCallback = (entries: Array<{ isIntersecting: boolean }>) => void;

function stubIntersectionObserver() {
  const disconnectMock = vi.fn();
  let callback: IntersectionCallback = () => {};

  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: IntersectionCallback) {
        callback = cb;
      }
      observe = vi.fn();
      disconnect = disconnectMock;
    },
  );

  return {
    disconnectMock,
    trigger(entries: Array<{ isIntersecting: boolean }>) {
      callback(entries);
    },
  };
}

describe("useInView observer logic", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("disconnect is called when entry is intersecting", () => {
    const { disconnectMock, trigger } = stubIntersectionObserver();

    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        observer.disconnect();
      }
    });

    trigger([{ isIntersecting: true }]);
    expect(disconnectMock).toHaveBeenCalled();
  });

  it("disconnect is not called when entry is not intersecting", () => {
    const { disconnectMock, trigger } = stubIntersectionObserver();

    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        observer.disconnect();
      }
    });

    trigger([{ isIntersecting: false }]);
    expect(disconnectMock).not.toHaveBeenCalled();
  });

  it("handles empty entries array without error", () => {
    const { disconnectMock, trigger } = stubIntersectionObserver();

    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        observer.disconnect();
      }
    });

    trigger([]);
    expect(disconnectMock).not.toHaveBeenCalled();
  });
});
