/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UnitContext } from "../lib/unitContext.ts";

const { analyzeUseQuery, createMutate, deleteMutate, listInvalidate, listUseQuery } = vi.hoisted(
  () => ({
    analyzeUseQuery: vi.fn(),
    createMutate: vi.fn(),
    deleteMutate: vi.fn(),
    listInvalidate: vi.fn(),
    listUseQuery: vi.fn(),
  }),
);

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    useUtils: () => ({
      lifeEvents: {
        list: {
          invalidate: listInvalidate,
        },
      },
    }),
    lifeEvents: {
      list: {
        useQuery: listUseQuery,
      },
      create: {
        useMutation: () => ({
          mutate: createMutate,
          isPending: false,
        }),
      },
      delete: {
        useMutation: () => ({
          mutate: deleteMutate,
        }),
      },
      analyze: {
        useQuery: analyzeUseQuery,
      },
    },
  },
}));

const { LifeEventsPanel } = await import("./LifeEventsPanel.tsx");

describe("LifeEventsPanel", () => {
  it("formats analyzed body weight with the shared unit formatter", () => {
    listUseQuery.mockReturnValue({
      data: [
        {
          id: "event-1",
          label: "Started creatine",
          started_at: "2026-02-01",
          ended_at: null,
          category: "supplement",
          ongoing: true,
          notes: null,
        },
      ],
    });
    analyzeUseQuery.mockReturnValue({
      isLoading: false,
      data: {
        event: {
          id: "event-1",
          label: "Started creatine",
          started_at: "2026-02-01",
          ended_at: null,
          category: "supplement",
          ongoing: true,
          notes: null,
        },
        metrics: [
          { period: "before", days: 30, avg_resting_hr: 58, avg_hrv: 62 },
          { period: "after", days: 30, avg_resting_hr: 57, avg_hrv: 64 },
        ],
        sleep: [
          { period: "before", nights: 29, avg_sleep_min: 430 },
          { period: "after", nights: 30, avg_sleep_min: 445 },
        ],
        bodyComp: [
          { period: "before", measurements: 6, avg_weight: 80 },
          { period: "after", measurements: 7, avg_weight: 79.5 },
        ],
      },
    });

    render(
      <UnitContext.Provider value={{ unitSystem: "imperial", setUnitSystem: () => {} }}>
        <LifeEventsPanel />
      </UnitContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Started creatine/i }));

    expect(screen.getByText("176.4 lb")).toBeDefined();
    expect(screen.getByText("175.3 lb")).toBeDefined();
    expect(screen.queryByText("[object Object]")).toBeNull();
  });
});
