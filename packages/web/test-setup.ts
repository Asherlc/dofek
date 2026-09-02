import "@testing-library/jest-dom/vitest";
import { installTestWebAccountStateLocks } from "./src/lib/web-account-state-lock.test-helpers.ts";
import { vi } from "vitest";

if (typeof navigator !== "undefined") {
  installTestWebAccountStateLocks();
}

if (typeof window !== "undefined") {
  const jsdomWindow = (globalThis as typeof globalThis & { jsdom?: { window: Window } }).jsdom?.window;
  for (const storageName of ["localStorage", "sessionStorage"] as const) {
    if (typeof window[storageName] === "undefined" && jsdomWindow) {
      Object.defineProperty(window, storageName, {
        configurable: true,
        value: jsdomWindow[storageName],
      });
    }
  }

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: false,
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })),
    writable: true,
  });
}
