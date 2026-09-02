/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted<{
  component: ComponentType | null;
  isLoading: boolean;
}>(() => ({
  component: null,
  isLoading: true,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: ComponentType }) => {
    state.component = options.component;
    return options;
  },
}));

vi.mock("../../components/SupplementDoseEventsPanel.tsx", () => ({
  SupplementDoseEventsPanel: () => <div>Dose events</div>,
}));

vi.mock("../../components/SupplementStackPanel.tsx", () => ({
  SupplementStackPanel: () => <div>Supplement stack</div>,
}));

vi.mock("../../lib/trpc.ts", () => ({
  trpc: {
    nutritionAnalytics: {
      micronutrientAdequacyV2: {
        useQuery: () => ({
          data: undefined,
          error: null,
          isError: false,
          isLoading: state.isLoading,
        }),
      },
    },
  },
}));

describe("nutrition supplements route", () => {
  beforeEach(async () => {
    state.component = null;
    state.isLoading = true;
    vi.resetModules();
    await import("./supplements.tsx");
  });

  it("renders an explicit loading state for the safety review", () => {
    const Component = state.component;
    if (Component == null) {
      throw new Error("Route component was not captured.");
    }

    render(<Component />);

    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
  });
});
