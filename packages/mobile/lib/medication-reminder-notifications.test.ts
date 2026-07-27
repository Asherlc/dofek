import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  cancelScheduledNotificationAsync,
  getAllScheduledNotificationsAsync,
  getPermissionsAsync,
  requestPermissionsAsync,
  scheduleNotificationAsync,
} = vi.hoisted(() => ({
  cancelScheduledNotificationAsync: vi.fn(),
  getAllScheduledNotificationsAsync: vi.fn(),
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  scheduleNotificationAsync: vi.fn(),
}));

vi.mock("expo-notifications", () => ({
  SchedulableTriggerInputTypes: {
    DAILY: "daily",
  },
  cancelScheduledNotificationAsync,
  getAllScheduledNotificationsAsync,
  getPermissionsAsync,
  requestPermissionsAsync,
  scheduleNotificationAsync,
  setNotificationHandler: vi.fn(),
}));

import {
  MEDICATION_REMINDER_NOTIFICATION_URL,
  resolveMedicationReminderNotificationPath,
  syncMedicationReminderNotifications,
} from "./medication-reminder-notifications.ts";

describe("syncMedicationReminderNotifications", () => {
  beforeEach(() => {
    cancelScheduledNotificationAsync.mockReset();
    getAllScheduledNotificationsAsync.mockReset();
    getPermissionsAsync.mockReset();
    requestPermissionsAsync.mockReset();
    scheduleNotificationAsync.mockReset();
    cancelScheduledNotificationAsync.mockResolvedValue(undefined);
    getAllScheduledNotificationsAsync.mockResolvedValue([]);
    getPermissionsAsync.mockResolvedValue({ status: "undetermined" });
    requestPermissionsAsync.mockResolvedValue({ status: "granted" });
    scheduleNotificationAsync.mockResolvedValue("scheduled-id");
  });
  it("requests permission only when enabling and schedules daily local notifications", async () => {
    getPermissionsAsync.mockResolvedValue({ status: "undetermined" });
    requestPermissionsAsync.mockResolvedValue({ status: "granted" });
    scheduleNotificationAsync.mockResolvedValue("scheduled-id");

    await syncMedicationReminderNotifications([
      {
        id: "11111111-1111-4111-8111-111111111111",
        medicationName: "Vitamin D3",
        localTime: "08:30",
        enabled: true,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        medicationName: "Metformin",
        localTime: "21:00",
        enabled: false,
      },
    ]);

    expect(requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(scheduleNotificationAsync).toHaveBeenCalledWith({
      identifier: "11111111-1111-4111-8111-111111111111",
      content: {
        title: "Medication reminder",
        body: "Time to take Vitamin D3",
        data: {
          url: MEDICATION_REMINDER_NOTIFICATION_URL,
          reminderId: "11111111-1111-4111-8111-111111111111",
        },
      },
      trigger: {
        type: "daily",
        hour: 8,
        minute: 30,
      },
    });
  });

  it("cancels orphaned medication notifications for deleted reminders", async () => {
    getPermissionsAsync.mockResolvedValue({ status: "granted" });
    getAllScheduledNotificationsAsync.mockResolvedValue([
      {
        identifier: "deleted-reminder-id",
        content: {
          data: {
            url: MEDICATION_REMINDER_NOTIFICATION_URL,
            reminderId: "deleted-reminder-id",
          },
        },
      },
      {
        identifier: "unrelated-notification",
        content: {
          data: {
            url: "/settings?focus=other",
          },
        },
      },
    ]);

    await syncMedicationReminderNotifications([
      {
        id: "11111111-1111-4111-8111-111111111111",
        medicationName: "Vitamin D3",
        localTime: "08:30",
        enabled: true,
      },
    ]);

    expect(cancelScheduledNotificationAsync).toHaveBeenCalledWith("deleted-reminder-id");
    expect(cancelScheduledNotificationAsync).not.toHaveBeenCalledWith("unrelated-notification");
    expect(scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        identifier: "11111111-1111-4111-8111-111111111111",
      }),
    );
  });

  it("does not request permission when every reminder is disabled", async () => {
    getAllScheduledNotificationsAsync.mockResolvedValue([
      {
        identifier: "11111111-1111-4111-8111-111111111111",
        content: {
          data: {
            url: MEDICATION_REMINDER_NOTIFICATION_URL,
            reminderId: "11111111-1111-4111-8111-111111111111",
          },
        },
      },
    ]);

    await syncMedicationReminderNotifications([
      {
        id: "11111111-1111-4111-8111-111111111111",
        medicationName: "Vitamin D3",
        localTime: "08:30",
        enabled: false,
      },
    ]);

    expect(requestPermissionsAsync).not.toHaveBeenCalled();
    expect(scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(cancelScheduledNotificationAsync).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
  });
});

describe("resolveMedicationReminderNotificationPath", () => {
  it("appends reminderId to the settings deep link", () => {
    expect(
      resolveMedicationReminderNotificationPath({
        url: MEDICATION_REMINDER_NOTIFICATION_URL,
        reminderId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toBe("/settings?focus=medicationReminders&reminderId=11111111-1111-4111-8111-111111111111");
  });
});
