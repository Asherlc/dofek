/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkInQuery: vi.fn(),
  regionsQuery: vi.fn(),
  injuriesQuery: vi.fn(),
  saveCheckIn: vi.fn(),
  createInjury: vi.fn(),
  invalidate: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("../lib/telemetry.ts", () => ({ captureException: mocks.captureException }));
vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    useUtils: () => ({
      subjective: {
        checkIn: { invalidate: mocks.invalidate },
        timeline: { invalidate: mocks.invalidate },
        injuries: { invalidate: mocks.invalidate },
      },
    }),
    subjective: {
      checkIn: { useQuery: mocks.checkInQuery },
      regions: { useQuery: mocks.regionsQuery },
      injuries: { useQuery: mocks.injuriesQuery },
      saveCheckIn: {
        useMutation: () => ({ error: null, isPending: false, mutate: mocks.saveCheckIn }),
      },
      createInjury: {
        useMutation: () => ({ error: null, isPending: false, mutate: mocks.createInjury }),
      },
    },
  },
}));

import { SubjectiveTrackingPanel } from "./SubjectiveTrackingPanel.tsx";

describe("SubjectiveTrackingPanel", () => {
  beforeEach(() => {
    mocks.checkInQuery.mockReturnValue({ data: { logged: false, symptoms: [] } });
    mocks.regionsQuery.mockReturnValue({
      data: [{ id: "left_hand", label: "Left hand", kind: "hand", parent_id: "body" }],
    });
    mocks.injuriesQuery.mockReturnValue({ data: [] });
    mocks.saveCheckIn.mockReset();
    mocks.createInjury.mockReset();
    mocks.invalidate.mockReset();
    mocks.captureException.mockReset();
  });

  it("logs an explicit all-clear check-in", () => {
    render(<SubjectiveTrackingPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Log all clear" }));
    expect(mocks.saveCheckIn).toHaveBeenCalledWith({ date: expect.any(String), symptoms: [] });
  });

  it("saves a sparse symptom without turning missing regions into zeros", () => {
    render(<SubjectiveTrackingPanel />);
    fireEvent.change(screen.getByRole("combobox", { name: "Body region" }), {
      target: { value: "left_hand" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Symptom score" }), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add symptom" }));
    fireEvent.click(screen.getByRole("button", { name: "Save check-in" }));
    expect(mocks.saveCheckIn).toHaveBeenCalledWith({
      date: expect.any(String),
      symptoms: [{ bodyRegionId: "left_hand", kind: "soreness", score: 4 }],
    });
  });

  it("creates an injury or niggle with the selected region", () => {
    render(<SubjectiveTrackingPanel />);
    fireEvent.change(screen.getByRole("combobox", { name: "Body region" }), {
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
  });

  it("creates an injury with its own kind and zero severity", () => {
    render(<SubjectiveTrackingPanel />);
    fireEvent.change(screen.getByRole("combobox", { name: "Body region" }), {
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
});
