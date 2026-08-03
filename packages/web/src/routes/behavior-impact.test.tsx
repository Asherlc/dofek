/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const routeState = vi.hoisted<{ component: ComponentType | null }>(() => ({
  component: null,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: { component: ComponentType }) => {
    routeState.component = config.component;
    return {};
  },
}));

vi.mock("../components/BehaviorImpactChart.tsx", () => ({
  BehaviorImpactChart: () => <div />,
}));
vi.mock("../components/DofekChart.tsx", () => ({
  ChartRangeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({
    children,
    title,
    subtitle,
  }: {
    children: ReactNode;
    title: string;
    subtitle: string;
  }) => (
    <main>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {children}
    </main>
  ),
}));
vi.mock("../components/TimeRangeSelector.tsx", () => ({
  TimeRangeSelector: () => <div />,
}));

describe("behavior impact route", () => {
  afterEach(cleanup);

  it("frames behavior readiness results as associations", async () => {
    await import("./behavior-impact.tsx");
    const BehaviorImpactPage = routeState.component;
    if (!BehaviorImpactPage) throw new Error("Behavior impact route component was not captured");

    render(<BehaviorImpactPage />);

    expect(screen.getByRole("heading", { name: "Behavior Associations" })).toBeDefined();
    expect(
      screen.getByText("How your daily behaviors are associated with next-day readiness"),
    ).toBeDefined();
  });
});
