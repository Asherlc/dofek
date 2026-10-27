/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: { component: () => ReactNode }) => config,
  Outlet: () => <div>Training child route</div>,
}));

vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({ tabs, children }: { tabs: Array<{ label: string }>; children: ReactNode }) => (
    <div>
      {tabs.map((tab) => (
        <span key={tab.label}>{tab.label}</span>
      ))}
      {children}
    </div>
  ),
}));

vi.mock("../components/TimeRangeSelector.tsx", () => ({
  TimeRangeSelector: () => <div>Time range selector</div>,
}));

function routeComponent(route: unknown): () => ReactNode {
  if (typeof route !== "object" || route === null || !("component" in route)) {
    throw new Error("Route component not found");
  }
  const component = route.component;
  if (typeof component !== "function") {
    throw new Error("Route component is not callable");
  }
  return () => component();
}

describe("Training layout", () => {
  afterEach(cleanup);

  it("includes the Climbing training tab", async () => {
    const { Route } = await import("./training.tsx");
    const TrainingLayout = routeComponent(Route);

    render(<TrainingLayout />);

    expect(screen.getByText("Climbing")).toBeTruthy();
    expect(screen.getByText("Training child route")).toBeTruthy();
  });
});
