// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPageNavigationStart } from "./lib/page-load-context.tsx";

const events = vi.hoisted(
  () => new Map<string, (event: { toLocation: { href: string } }) => void>(),
);
vi.mock("@tanstack/react-router", () => ({
  createRouter: () => ({
    subscribe: (name: string, callback: (event: { toLocation: { href: string } }) => void) => {
      events.set(name, callback);
    },
  }),
  RouterProvider: () => (
    <>
      <a href="/body" onClick={(event) => event.preventDefault()}>
        Unrelated link
      </a>
      <a
        href="/dashboard"
        onClick={(event) => {
          event.preventDefault();
          events.get("onBeforeNavigate")?.({ toLocation: { href: "/dashboard" } });
        }}
      >
        Dashboard link
      </a>
      <button
        type="button"
        onClick={() => events.get("onBeforeNavigate")?.({ toLocation: { href: "/activities" } })}
      >
        Programmatic navigation
      </button>
    </>
  ),
}));
vi.mock("./routeTree.gen.ts", () => ({ routeTree: {} }));
vi.mock("./components/DataConnectionBanner.tsx", () => ({ DataConnectionBanner: () => null }));
vi.mock("./components/ErrorBoundary.tsx", () => ({
  ErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./lib/FetchingContext.tsx", () => ({
  FetchingProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./lib/posthog.ts", () => ({
  initPostHog: vi.fn(),
  capturePageView: vi.fn(),
  capturePageLoad: vi.fn(),
}));
vi.mock("./lib/trpc.ts", () => ({
  createTRPCClient: () => ({}),
  trpc: { Provider: ({ children }: { children: ReactNode }) => children },
}));

import { App } from "./App.tsx";

function click(name: string, timeStamp: number, options: MouseEventInit = {}) {
  const element = screen.getByText(name);
  const event = createEvent.click(element, options);
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  fireEvent(element, event);
}

beforeEach(() => {
  vi.spyOn(performance, "now").mockReturnValue(700);
  events.get("onResolved")?.({ toLocation: { href: "/" } });
  events.get("onBeforeNavigate")?.({ toLocation: { href: "/" } });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("navigation measurement input", () => {
  it.each(["click", "popstate"])(
    "retains %s timing across a native checkpoint before the router listener, consuming it once",
    async (type) => {
      const listeners = vi.spyOn(type === "click" ? document : window, "addEventListener");
      render(<App />);
      const capture = listeners.mock.calls.find(
        ([name, , options]) => name === type && options === true,
      )?.[1];
      if (typeof capture !== "function") throw new Error(`Missing ${type} capture listener`);
      const event = type === "click" ? new MouseEvent(type) : new PopStateEvent(type);
      let phase: number = Event.CAPTURING_PHASE;
      Object.defineProperties(event, {
        target: { value: screen.getByText("Dashboard link") },
        timeStamp: { value: 300 },
        eventPhase: { get: () => phase },
      });
      capture(event);
      // Native callbacks run a checkpoint between capture and delegated bubble listeners.
      await Promise.resolve();
      phase = Event.BUBBLING_PHASE;
      const href = type === "click" ? "/dashboard" : window.location.href;
      events.get("onBeforeNavigate")?.({ toLocation: { href } });
      expect(getPageNavigationStart()).toBe(300);
      events.get("onBeforeNavigate")?.({ toLocation: { href } });
      expect(getPageNavigationStart()).toBe(700);
      phase = Event.NONE;
    },
  );
  it("rejects a stopped link input immediately after dispatch, before any checkpoint", () => {
    render(<App />);
    screen.getByText("Unrelated link").addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    click("Unrelated link", 200);
    events.get("onBeforeNavigate")?.({ toLocation: { href: "/body" } });
    expect(getPageNavigationStart()).toBe(700);
  });
  it("does not reuse an unrelated prevented link click for programmatic navigation", async () => {
    render(<App />);
    click("Unrelated link", 200);
    await Promise.resolve();
    click("Programmatic navigation", 600);
    expect(getPageNavigationStart()).toBe(700);
  });
  it("preserves the actual input timestamp for a link navigation to its destination", () => {
    render(<App />);
    click("Dashboard link", 300);
    expect(getPageNavigationStart()).toBe(300);
  });
  it("does not associate a link timestamp with navigation to a different destination in the same turn", () => {
    render(<App />);
    click("Unrelated link", 200);
    events.get("onBeforeNavigate")?.({ toLocation: { href: "/activities" } });
    expect(getPageNavigationStart()).toBe(700);
  });
  it.each(["alt", "target", "download"])(
    "ignores %s link input even when navigation occurs in the same turn",
    (kind) => {
      render(<App />);
      const link = screen.getByText("Unrelated link");
      if (kind === "target") link.setAttribute("target", "_blank");
      if (kind === "download") link.setAttribute("download", "file");
      click("Unrelated link", 200, { altKey: kind === "alt" });
      events.get("onBeforeNavigate")?.({ toLocation: { href: "/body" } });
      expect(getPageNavigationStart()).toBe(700);
    },
  );
  it("discards a prevented link timestamp even for a later navigation to the same destination", async () => {
    render(<App />);
    click("Unrelated link", 200);
    await Promise.resolve();
    events.get("onBeforeNavigate")?.({ toLocation: { href: "/body" } });
    expect(getPageNavigationStart()).toBe(700);
  });
  it("captures history input before the router starts history navigation", () => {
    const navigate = () =>
      events.get("onBeforeNavigate")?.({ toLocation: { href: window.location.href } });
    window.addEventListener("popstate", navigate);
    render(<App />);
    const event = new PopStateEvent("popstate");
    Object.defineProperty(event, "timeStamp", { value: 500 });
    window.dispatchEvent(event);
    window.removeEventListener("popstate", navigate);
    expect(getPageNavigationStart()).toBe(500);
  });
});
