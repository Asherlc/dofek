/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MutationOptions = { onSuccess?: () => void };

const mocks = vi.hoisted(() => ({
  checkInQuery: vi.fn(),
  regionsQuery: vi.fn(),
  injuriesQuery: vi.fn(),
  saveCheckIn: vi.fn(),
  createInjury: vi.fn(),
  checkInInvalidate: vi.fn(),
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
        checkIn: { invalidate: mocks.checkInInvalidate },
        timeline: { invalidate: mocks.timelineInvalidate },
        injuries: { invalidate: mocks.injuriesInvalidate },
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
    mocks.checkInQuery.mockReturnValue({ data: { logged: false, symptoms: [] } });
    mocks.regionsQuery.mockReturnValue({
      data: [{ id: "left_hand", label: "Left hand", kind: "hand", parent_id: "body" }],
    });
    mocks.injuriesQuery.mockReturnValue({ data: [] });
    mocks.saveCheckIn.mockReset();
    mocks.createInjury.mockReset();
    mocks.checkInInvalidate.mockReset();
    mocks.injuriesInvalidate.mockReset();
    mocks.timelineInvalidate.mockReset();
    mocks.captureException.mockReset();
  });

  it("logs an explicit all-clear check-in", () => {
    render(<SubjectiveTrackingPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Log all clear" }));
    expect(mocks.saveCheckIn).toHaveBeenCalledWith({ date: expect.any(String), symptoms: [] });
  });

  it("clears a staged symptom when logging all clear", () => {
    mocks.checkInQuery.mockReturnValue({ data: { logged: true, symptoms: [] } });
    render(<SubjectiveTrackingPanel />);
    fireEvent.change(screen.getByRole("combobox", { name: "Body region" }), {
      target: { value: "left_hand" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add symptom" }));
    expect(screen.getByText(/Left hand · soreness/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Log all clear" }));

    expect(screen.queryByText(/Left hand · soreness/)).not.toBeInTheDocument();
    expect(screen.getByText("All clear")).toBeInTheDocument();
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
    expect(mocks.checkInInvalidate).not.toHaveBeenCalled();
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

  it("keeps symptom and injury region selections independent", () => {
    mocks.regionsQuery.mockReturnValue({
      data: [
        { id: "left_hand", label: "Left hand", kind: "hand", parent_id: "body" },
        { id: "right_hand", label: "Right hand", kind: "hand", parent_id: "body" },
      ],
    });
    render(<SubjectiveTrackingPanel />);

    fireEvent.change(screen.getByRole("combobox", { name: "Body region" }), {
      target: { value: "left_hand" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Injury body region" }), {
      target: { value: "right_hand" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Injury description" }), {
      target: { value: "Right hand pain" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add niggle" }));

    expect(mocks.createInjury).toHaveBeenCalledWith(
      expect.objectContaining({ bodyRegionId: "right_hand" }),
    );
  });

  it("clamps symptom scores before saving", () => {
    render(<SubjectiveTrackingPanel />);
    fireEvent.change(screen.getByRole("combobox", { name: "Body region" }), {
      target: { value: "left_hand" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Symptom score" }), {
      target: { value: "15" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add symptom" }));
    fireEvent.click(screen.getByRole("button", { name: "Save check-in" }));

    expect(mocks.saveCheckIn).toHaveBeenCalledWith({
      date: expect.any(String),
      symptoms: [{ bodyRegionId: "left_hand", kind: "soreness", score: 10 }],
    });
  });

  it("preserves unsaved symptoms when the check-in refetches", () => {
    const view = render(<SubjectiveTrackingPanel />);
    fireEvent.change(screen.getByRole("combobox", { name: "Body region" }), {
      target: { value: "left_hand" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add symptom" }));

    mocks.checkInQuery.mockReturnValue({ data: { logged: false, symptoms: [] } });
    view.rerender(<SubjectiveTrackingPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Save check-in" }));

    expect(mocks.saveCheckIn).toHaveBeenCalledWith({
      date: expect.any(String),
      symptoms: [{ bodyRegionId: "left_hand", kind: "soreness", score: 1 }],
    });
  });

  it("shows a region query error instead of an empty selector", () => {
    mocks.regionsQuery.mockReturnValue({
      data: undefined,
      error: new Error("Regions unavailable"),
    });

    render(<SubjectiveTrackingPanel />);

    expect(screen.getAllByText("Regions unavailable")).toHaveLength(2);
    expect(screen.queryByRole("combobox", { name: "Body region" })).not.toBeInTheDocument();
  });
});
