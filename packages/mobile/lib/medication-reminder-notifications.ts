import { type MedicationReminder, parseLocalTime } from "@dofek/format/medication-reminders";
import * as Notifications from "expo-notifications";
import { z } from "zod";

export const MEDICATION_REMINDER_NOTIFICATION_URL = "/settings?focus=medicationReminders" as const;

const notificationDataSchema = z.object({
  url: z.string().optional(),
  reminderId: z.string().optional(),
});

let notificationHandlerConfigured = false;

function configureNotificationHandler(): void {
  if (notificationHandlerConfigured) return;
  notificationHandlerConfigured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

async function ensureNotificationPermission(): Promise<boolean> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.status === "granted") return true;

  const requested = await Notifications.requestPermissionsAsync();
  return requested.status === "granted";
}

export async function purgeScheduledMedicationReminderNotifications(): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  for (const notification of scheduled) {
    const parsed = notificationDataSchema.safeParse(notification.content.data);
    if (!parsed.success || parsed.data.url !== MEDICATION_REMINDER_NOTIFICATION_URL) continue;
    await Notifications.cancelScheduledNotificationAsync(notification.identifier);
  }
}

export async function syncMedicationReminderNotifications(
  reminders: MedicationReminder[],
): Promise<void> {
  configureNotificationHandler();

  const enabledReminders = reminders.filter((reminder) => reminder.enabled);
  if (enabledReminders.length > 0) {
    const granted = await ensureNotificationPermission();
    if (!granted) {
      await purgeScheduledMedicationReminderNotifications();
      return;
    }
  }

  // Cancel first so deleted reminder IDs never leave orphaned daily notifications.
  await purgeScheduledMedicationReminderNotifications();

  for (const reminder of enabledReminders) {
    const { hour, minute } = parseLocalTime(reminder.localTime);
    await Notifications.scheduleNotificationAsync({
      identifier: reminder.id,
      content: {
        title: "Medication reminder",
        body: `Time to take ${reminder.medicationName}`,
        data: {
          url: MEDICATION_REMINDER_NOTIFICATION_URL,
          reminderId: reminder.id,
        },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour,
        minute,
      },
    });
  }
}

export function resolveMedicationReminderNotificationPath(data: unknown): string | null {
  const parsed = notificationDataSchema.safeParse(data);
  if (!parsed.success) return null;
  const url = parsed.data.url;
  if (url == null || !url.startsWith("/settings")) return null;

  const reminderId = parsed.data.reminderId;
  if (reminderId != null && reminderId.length > 0) {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}reminderId=${encodeURIComponent(reminderId)}`;
  }
  return url;
}
