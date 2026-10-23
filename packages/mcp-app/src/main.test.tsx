/** @vitest-environment jsdom */

import { App } from "@modelcontextprotocol/ext-apps";
import { act, screen } from "@testing-library/react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseApp, roots } = vi.hoisted(() => {
  const roots: Root[] = [];
  return { mockUseApp: vi.fn(), roots };
});

vi.mock("@modelcontextprotocol/ext-apps/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@modelcontextprotocol/ext-apps/react")>()),
  useApp: mockUseApp,
}));

vi.mock("react-dom/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-dom/client")>();
  return {
    ...original,
    createRoot: (...args: Parameters<typeof original.createRoot>) => {
      const root = original.createRoot(...args);
      roots.push(root);
      return root;
    },
  };
});

beforeEach(() => vi.resetModules());

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("Dofek MCP App theme", () => {
  it("applies the initial host theme and follows theme changes while loading", async () => {
    const app = new App({ name: "Dofek", version: "0.1.0" }, {});
    vi.spyOn(app, "getHostContext").mockReturnValue({ theme: "dark" });
    const listeners = vi.spyOn(app, "addEventListener");
    mockUseApp.mockReturnValue({ app, isConnected: true, error: null });
    document.body.innerHTML = '<div id="root"></div>';

    await act(async () => {
      await import("./main.tsx");
    });

    expect(screen.getByText("Loading Dofek…")).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    const onHostContextChanged = listeners.mock.calls.find(
      ([event]) => event === "hostcontextchanged",
    )?.[1];
    expect(onHostContextChanged).toBeDefined();
    await act(async () => {
      onHostContextChanged?.({ theme: "light" });
    });

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });
});
