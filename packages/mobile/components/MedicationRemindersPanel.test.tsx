/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  getData: vi.fn(),
  invalidate: vi.fn(),
  mutate: vi.fn(),
  setData: vi.fn(),
  syncMedicationReminderNotifications: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/telemetry", () => ({ captureException: mocks.captureException }));
vi.mock("../lib/medication-reminder-notifications", () => ({
  syncMedicationReminderNotifications: mocks.syncMedicationReminderNotifications,
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    medicationDoseEvents: {
      list: {
        useQuery: () => ({ data: { events: [] }, isLoading: false, error: null }),
      },
    },
    settings: {
      get: {
        useQuery: () => ({
          data: { key: "medicationReminders", value: [] },
          isLoading: false,
          error: null,
        }),
      },
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

import { MedicationRemindersPanel } from "./MedicationRemindersPanel";

describe("MedicationRemindersPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", {
      randomUUID: () => "22222222-2222-4222-8222-222222222222",
    });
    mocks.captureException.mockReset();
    mocks.getData.mockReset();
    mocks.invalidate.mockReset();
    mocks.mutate.mockReset();
    mocks.setData.mockReset();
    mocks.syncMedicationReminderNotifications.mockClear();
  });

  it("renders empty state and adds a reminder", () => {
    mocks.getData.mockReturnValue({ key: "medicationReminders", value: [] });

    render(
      <MedicationRemindersPanel
        remindersQueryResult={{
          isLoading: false,
          error: null,
          data: { key: "medicationReminders", value: [] },
        }}
        doseEventsQueryResult={{
          isLoading: false,
          error: null,
          data: { events: [] },
        }}
      />,
    );

    expect(screen.getByText("No medication reminders yet.")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Vitamin D3"), {
      target: { value: "Metformin" },
    });
    fireEvent.change(screen.getByDisplayValue("08:00"), {
      target: { value: "21:00" },
    });
    fireEvent.click(screen.getByText("Add reminder"));

    expect(mocks.mutate).toHaveBeenCalledWith(
      {
        key: "medicationReminders",
        value: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            medicationName: "Metformin",
            localTime: "21:00",
            enabled: true,
          },
        ],
      },
      expect.any(Object),
    );
  });

  it("rejects invalid local times before writing", () => {
    mocks.getData.mockReturnValue({ key: "medicationReminders", value: [] });

    render(
      <MedicationRemindersPanel
        remindersQueryResult={{
          isLoading: false,
          error: null,
          data: { key: "medicationReminders", value: [] },
        }}
        doseEventsQueryResult={{
          isLoading: false,
          error: null,
          data: { events: [] },
        }}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Vitamin D3"), {
      target: { value: "Metformin" },
    });
    fireEvent.change(screen.getByDisplayValue("08:00"), {
      target: { value: "8:00" },
    });
    fireEvent.click(screen.getByText("Add reminder"));

    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(screen.getByText("Time must be in HH:mm 24-hour format (e.g., 08:30).")).toBeTruthy();
  });

  it("ignores malformed imported dose events instead of crashing", () => {
    render(
      <MedicationRemindersPanel
        remindersQueryResult={{
          isLoading: false,
          error: null,
          data: {
            key: "medicationReminders",
            value: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                medicationName: "Vitamin D3",
                localTime: "08:30",
                enabled: true,
              },
            ],
          },
        }}
        doseEventsQueryResult={{
          isLoading: false,
          error: null,
          data: {
            events: [{ id: "bad-event" }],
          },
        }}
      />,
    );

    expect(screen.getByText("Vitamin D3")).toBeTruthy();
    expect(screen.getByText("No imported dose log yet.")).toBeTruthy();
  });

  it("shows imported logging state for matching reminders", () => {
    render(
      <MedicationRemindersPanel
        remindersQueryResult={{
          isLoading: false,
          error: null,
          data: {
            key: "medicationReminders",
            value: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                medicationName: "Vitamin D3",
                localTime: "08:30",
                enabled: true,
              },
            ],
          },
        }}
        doseEventsQueryResult={{
          isLoading: false,
          error: null,
          data: {
            events: [
              {
                id: "event-1",
                providerId: "apple_health",
                medicationName: "Vitamin D3",
                medicationConceptId: null,
                doseStatus: "skipped",
                recordedAt: "2026-07-25T16:00:00.000Z",
                sourceName: "Apple Health",
              },
            ],
          },
        }}
      />,
    );

    expect(screen.getByText("Vitamin D3")).toBeTruthy();
    expect(screen.getByText(/Latest log: Skipped/)).toBeTruthy();
  });
});
