/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  getData: vi.fn(),
  invalidate: vi.fn(),
  listUseQuery: vi.fn(),
  mutate: vi.fn(),
  setData: vi.fn(),
  settingsUseQuery: vi.fn(),
}));

vi.mock("../lib/telemetry.ts", () => ({ captureException: mocks.captureException }));
vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    medicationDoseEvents: {
      list: {
        useQuery: mocks.listUseQuery,
      },
    },
    settings: {
      get: { useQuery: mocks.settingsUseQuery },
      set: { useMutation: () => ({ mutate: mocks.mutate, isPending: false }) },
    },
    useUtils: () => ({
      settings: {
        get: {
          getData: mocks.getData,
          invalidate: mocks.invalidate,
          setData: mocks.setData,
        },
      },
    }),
  },
}));

import { MedicationRemindersPanel } from "./MedicationRemindersPanel.tsx";

const existingReminder = {
  id: "11111111-1111-4111-8111-111111111111",
  medicationName: "Vitamin D3",
  localTime: "08:30",
  enabled: true,
};

describe("MedicationRemindersPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", {
      randomUUID: () => "22222222-2222-4222-8222-222222222222",
    });
    mocks.captureException.mockReset();
    mocks.getData.mockReset();
    mocks.invalidate.mockReset();
    mocks.listUseQuery.mockReset();
    mocks.mutate.mockReset();
    mocks.setData.mockReset();
    mocks.settingsUseQuery.mockReset();
    mocks.settingsUseQuery.mockReturnValue({
      data: { key: "medicationReminders", value: [existingReminder] },
      error: null,
      isLoading: false,
    });
    mocks.listUseQuery.mockReturnValue({
      data: {
        events: [
          {
            id: "event-1",
            providerId: "apple_health",
            medicationName: "Vitamin D3",
            medicationConceptId: null,
            doseStatus: "taken",
            recordedAt: "2026-07-25T16:00:00.000Z",
            sourceName: "Apple Health",
          },
        ],
      },
      error: null,
      isLoading: false,
    });
  });

  it("renders reminders with imported logging state", () => {
    render(<MedicationRemindersPanel />);

    expect(screen.getByText("Vitamin D3")).toBeTruthy();
    expect(screen.getByText("08:30")).toBeTruthy();
    expect(screen.getByText(/Latest log: Taken/)).toBeTruthy();
  });

  it("shows an empty state when no reminders exist", () => {
    mocks.settingsUseQuery.mockReturnValue({
      data: { key: "medicationReminders", value: [] },
      error: null,
      isLoading: false,
    });

    render(<MedicationRemindersPanel />);

    expect(screen.getByText("No medication reminders yet.")).toBeTruthy();
  });

  it("adds a reminder through settings.set", () => {
    mocks.getData.mockReturnValue({ key: "medicationReminders", value: [existingReminder] });

    render(<MedicationRemindersPanel />);

    fireEvent.change(screen.getByLabelText("Medication name"), {
      target: { value: "Metformin" },
    });
    fireEvent.change(screen.getByLabelText("Daily time"), {
      target: { value: "21:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add reminder" }));

    expect(mocks.mutate).toHaveBeenCalledWith(
      {
        key: "medicationReminders",
        value: [
          existingReminder,
          {
            id: "22222222-2222-4222-8222-222222222222",
            medicationName: "Metformin",
            localTime: "21:00",
            enabled: true,
          },
        ],
      },
      expect.objectContaining({ onError: expect.any(Function), onSettled: expect.any(Function) }),
    );
  });

  it("rejects invalid local times before writing", () => {
    render(<MedicationRemindersPanel />);

    fireEvent.change(screen.getByLabelText("Medication name"), {
      target: { value: "Metformin" },
    });
    fireEvent.change(screen.getByLabelText("Daily time"), {
      target: { value: "8:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add reminder" }));

    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(screen.getByText("Time must be in HH:mm 24-hour format (e.g., 08:30).")).toBeTruthy();
  });

  it("disables and deletes reminders", () => {
    mocks.getData.mockReturnValue({ key: "medicationReminders", value: [existingReminder] });

    render(<MedicationRemindersPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      {
        key: "medicationReminders",
        value: [{ ...existingReminder, enabled: false }],
      },
      expect.any(Object),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      {
        key: "medicationReminders",
        value: [],
      },
      expect.any(Object),
    );
  });
});
