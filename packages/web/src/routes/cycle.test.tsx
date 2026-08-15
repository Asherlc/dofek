/** @vitest-environment jsdom */

import { render, screen, within } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type PhaseData = {
  phase: "menstrual" | "follicular" | "ovulatory" | "luteal" | null;
  dayOfCycle: number | null;
  cycleLength: number | null;
  estimate: {
    phaseLabel: string;
    cycleDayLabel: string;
    dayBasisLabel: string;
    methodLabel: string;
    uncertaintyLabel: string;
    limitationLabel: string;
  } | null;
  latestCycleStart: unknown;
  availability: { status: string; label: string };
};

type CycleStart = {
  id: string;
  startDate: string;
  sources: Array<{
    providerId: string;
    sourceName: string | null;
    sourceBundle: string | null;
  }>;
};

const state = vi.hoisted(() => ({
  component: null as ComponentType | null,
  phase: { data: undefined as PhaseData | undefined, isLoading: false, error: null as Error | null },
  history: {
    data: [] as CycleStart[] | undefined,
    isLoading: false,
    error: null as Error | null,
  },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, search, to }: { children: ReactNode; search?: { tab?: string }; to: string }) => (
    <a href={search?.tab ? `${to}?tab=${search.tab}` : to}>{children}</a>
  ),
  createFileRoute: () => (options: { component: ComponentType }) => {
    state.component = options.component;
    return {};
  },
}));

vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({ children, title }: { children: ReactNode; title: string }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    menstrualCycle: {
      currentPhase: { useQuery: () => state.phase },
      history: { useQuery: () => state.history },
    },
  },
}));

import "./cycle.tsx";

function renderPage() {
  if (!state.component) throw new Error("Cycle route component was not captured");
  const Component = state.component;
  return render(<Component />);
}

describe("CyclePage", () => {
  beforeEach(() => {
    state.phase = { data: undefined, isLoading: false, error: null };
    state.history = { data: [], isLoading: false, error: null };
  });

  it("renders the complete server-authored estimate and safety notice", () => {
    state.phase.data = {
      phase: "menstrual",
      dayOfCycle: 3,
      cycleLength: 28,
      latestCycleStart: null,
      estimate: {
        phaseLabel: "Estimated Menstrual phase",
        cycleDayLabel: "Day 3 of an estimated 28-day cycle",
        dayBasisLabel: "Cycle day is counted from the latest provider cycle-start record.",
        methodLabel: "Phase and cycle length use the average of 3 completed cycles.",
        uncertaintyLabel: "Recorded cycle lengths ranged from 27 to 29 days.",
        limitationLabel: "No calibrated confidence score or next-period forecast is available.",
      },
      availability: { status: "estimated", label: "Phase estimate available." },
    };

    renderPage();

    expect(screen.getByText("Estimated Menstrual phase")).toBeTruthy();
    expect(screen.getByText("Day 3 of an estimated 28-day cycle")).toBeTruthy();
    expect(screen.getByText(/average of 3 completed cycles/)).toBeTruthy();
    expect(screen.getByText(/ranged from 27 to 29 days/)).toBeTruthy();
    expect(screen.getByText(/No calibrated confidence score/)).toBeTruthy();
    expect(screen.getByRole("note", { name: "Cycle tracking safety notice" })).toHaveTextContent(
      "Do not use for birth control or diagnosis",
    );
  });

  it("renders exact-date history with every provider source", () => {
    state.history.data = [
      {
        id: "cycle-start:2026-08-01",
        startDate: "2026-08-01",
        sources: [
          { providerId: "apple_health", sourceName: "Cycle Source", sourceBundle: "com.cycle" },
          { providerId: "garmin", sourceName: null, sourceBundle: "com.garmin.connect" },
        ],
      },
    ];

    renderPage();

    const item = screen.getByRole("listitem", { name: "Cycle start 2026-08-01" });
    expect(within(item).getByText("Cycle Source")).toBeTruthy();
    expect(within(item).getByText("com.garmin.connect")).toBeTruthy();
  });

  it("shows neutral permission guidance when no provider records are readable", () => {
    state.phase.data = {
      phase: null,
      dayOfCycle: null,
      cycleLength: null,
      estimate: null,
      latestCycleStart: null,
      availability: {
        status: "no-history",
        label: "No cycle starts are available from provider records.",
      },
    };

    renderPage();

    expect(screen.getByText("No cycle starts are available from provider records.")).toBeTruthy();
    expect(screen.getByText(/Apple Health permissions/)).toBeTruthy();
  });

  it("shows conflicting provider history without a phase graphic", () => {
    state.phase.data = {
      phase: null,
      dayOfCycle: null,
      cycleLength: null,
      estimate: null,
      latestCycleStart: null,
      availability: {
        status: "conflicting-history",
        label: "Provider cycle-start records conflict: 2026-06-01 and 2026-06-20.",
      },
    };

    renderPage();

    expect(screen.getByText(/2026-06-01 and 2026-06-20/)).toBeTruthy();
    expect(screen.queryByLabelText("Current cycle day")).toBeNull();
  });

  it("surfaces query errors and links to data-source and privacy controls", () => {
    state.phase.error = new Error("Current cycle query failed.");
    state.history = { data: undefined, isLoading: false, error: new Error("History query failed.") };

    renderPage();

    expect(screen.getByText("Current cycle query failed.")).toBeTruthy();
    expect(screen.getByText("History query failed.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Data sources" })).toHaveAttribute(
      "href",
      "/settings?tab=data-sources",
    );
    expect(screen.getByRole("link", { name: "Export all data" })).toHaveAttribute(
      "href",
      "/settings?tab=privacy-export",
    );
    expect(screen.getByRole("link", { name: "Delete account data" })).toHaveAttribute(
      "href",
      "/settings?tab=privacy-export",
    );
  });
});
