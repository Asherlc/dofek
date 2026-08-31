/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MutationOptions = { onSuccess?: () => void };

const mocks = vi.hoisted(() => ({
  regionsQuery: vi.fn(),
  injuriesQuery: vi.fn(),
  createInjury: vi.fn(),
  injuriesInvalidate: vi.fn(),
  timelineInvalidate: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("../lib/telemetry.ts", () => ({ captureException: mocks.captureException }));
vi.mock("../hooks/useTodayQueryDate.ts", () => ({
  useTodayQueryDate: () => "2026-08-02",
}));
vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    useUtils: () => ({
      subjective: {
        timeline: { invalidate: mocks.timelineInvalidate },
        injuries: { invalidate: mocks.injuriesInvalidate },
      },
    }),
    subjective: {
      regions: { useQuery: mocks.regionsQuery },
      injuries: { useQuery: mocks.injuriesQuery },
      createInjury: {
        useMutation: (options: MutationOptions) => ({
          error: null,
          isPending: false,
          mutate: (input: unknown) => {
            mocks.createInjury(input);
            options.onSuccess?.();
          },
        }),
      },
    },
  },
}));

import { SubjectiveTrackingPanel } from "./SubjectiveTrackingPanel.tsx";

describe("SubjectiveTrackingPanel", () => {
  beforeEach(() => {
    mocks.regionsQuery.mockReturnValue({
      data: [{ id: "left_hand", label: "Left hand", kind: "hand", parent_id: "body" }],
    });
    mocks.injuriesQuery.mockReturnValue({ data: [] });
    mocks.createInjury.mockReset();
    mocks.injuriesInvalidate.mockReset();
    mocks.timelineInvalidate.mockReset();
    mocks.captureException.mockReset();
  });

  it("creates an injury or niggle with the selected region", () => {
    render(<SubjectiveTrackingPanel />);
    fireEvent.change(screen.getByRole("combobox", { name: "Injury body region" }), {
      target: { value: "left_hand" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Injury description" }), {
      target: { value: "Morning tenderness" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add niggle" }));

    expect(mocks.createInjury).toHaveBeenCalledWith(
      expect.objectContaining({
        bodyRegionId: "left_hand",
        description: "Morning tenderness",
        kind: "niggle",
        severity: 0,
      }),
    );
    expect(mocks.injuriesInvalidate).toHaveBeenCalledTimes(1);
    expect(mocks.timelineInvalidate).toHaveBeenCalledTimes(1);
  });

  it("creates an injury with its own kind and zero severity", () => {
    render(<SubjectiveTrackingPanel />);
    fireEvent.change(screen.getByRole("combobox", { name: "Injury body region" }), {
      target: { value: "left_hand" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Injury type" }), {
      target: { value: "injury" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Injury description" }), {
      target: { value: "Resolved strain" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add injury" }));

    expect(mocks.createInjury).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "injury", severity: 0, description: "Resolved strain" }),
    );
  });

  it("uses an editable injury onset date", () => {
    render(<SubjectiveTrackingPanel />);
    fireEvent.change(screen.getByRole("combobox", { name: "Injury body region" }), {
      target: { value: "left_hand" },
    });
    fireEvent.change(screen.getByLabelText("Injury onset date"), {
      target: { value: "2026-07-31" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Injury description" }), {
      target: { value: "Earlier soreness" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add niggle" }));

    expect(mocks.createInjury).toHaveBeenCalledWith(
      expect.objectContaining({ onsetDate: "2026-07-31" }),
    );
  });

  it("does not submit an injury without an onset date", () => {
    render(<SubjectiveTrackingPanel />);
    fireEvent.change(screen.getByRole("combobox", { name: "Injury body region" }), {
      target: { value: "left_hand" },
    });
    fireEvent.change(screen.getByLabelText("Injury onset date"), { target: { value: "" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Injury description" }), {
      target: { value: "Missing onset" },
    });

    const addButton = screen.getByRole("button", { name: "Add niggle" });
    expect(addButton).toHaveProperty("disabled", true);
    fireEvent.click(addButton);
    expect(mocks.createInjury).not.toHaveBeenCalled();
  });

  it("shows a region query error instead of an empty selector", () => {
    mocks.regionsQuery.mockReturnValue({
      data: undefined,
      error: new Error("Regions unavailable"),
    });

    render(<SubjectiveTrackingPanel />);

    expect(screen.getByText("Regions unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Injury body region" })).not.toBeInTheDocument();
  });
});
