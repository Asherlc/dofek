import { formatDateTime } from "@dofek/format/format";
import { formatDoseStatus, medicationDoseEventSchema } from "@dofek/format/medication-dose-events";
import {
  findLatestDoseLoggingState,
  MEDICATION_REMINDERS_SETTINGS_KEY,
  type MedicationReminder,
  medicationReminderSchema,
  parseMedicationReminders,
} from "@dofek/format/medication-reminders";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

function createReminderId(): string {
  return crypto.randomUUID();
}

export function MedicationRemindersPanel({
  focusedReminderId,
}: {
  focusedReminderId?: string | null;
}) {
  const setting = trpc.settings.get.useQuery({ key: MEDICATION_REMINDERS_SETTINGS_KEY });
  const doseEvents = trpc.medicationDoseEvents.list.useQuery({ limit: 50 });
  const setSettingMutation = trpc.settings.set.useMutation();
  const trpcUtils = trpc.useUtils();
  const [writeError, setWriteError] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftTime, setDraftTime] = useState("08:00");
  const lastReadError = useRef<unknown>(null);
  const focusedRowRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (setting.error && lastReadError.current !== setting.error) {
      lastReadError.current = setting.error;
      captureException(setting.error, { context: "medication-reminders-read" });
    }
  }, [setting.error]);

  useEffect(() => {
    if (!focusedReminderId || !focusedRowRef.current) return;
    focusedRowRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusedReminderId]);

  if (setting.isLoading || doseEvents.isLoading) {
    return <QueryStatePanel variant="loading" height={96} />;
  }

  if (setting.error) {
    return <QueryStatePanel error={setting.error} height={96} />;
  }

  if (doseEvents.error) {
    return <QueryStatePanel error={doseEvents.error} height={96} />;
  }

  let reminders: MedicationReminder[] = [];
  try {
    reminders = parseMedicationReminders(setting.data?.value);
  } catch (error) {
    captureException(error, { context: "medication-reminders-parse" });
    return (
      <QueryStatePanel
        error={new Error("Saved medication reminders are invalid. Reset them to continue.")}
        height={96}
      />
    );
  }

  const eventsParsed = z.array(medicationDoseEventSchema).safeParse(doseEvents.data?.events ?? []);
  const events = eventsParsed.success ? eventsParsed.data : [];

  const persistReminders = (nextReminders: MedicationReminder[]) => {
    const previousSetting = trpcUtils.settings.get.getData({
      key: MEDICATION_REMINDERS_SETTINGS_KEY,
    });
    trpcUtils.settings.get.setData(
      { key: MEDICATION_REMINDERS_SETTINGS_KEY },
      { key: MEDICATION_REMINDERS_SETTINGS_KEY, value: nextReminders },
    );
    setWriteError(null);
    setSettingMutation.mutate(
      { key: MEDICATION_REMINDERS_SETTINGS_KEY, value: nextReminders },
      {
        onError: (error) => {
          trpcUtils.settings.get.setData(
            { key: MEDICATION_REMINDERS_SETTINGS_KEY },
            previousSetting,
          );
          setWriteError(error.message);
          captureException(error, { context: "medication-reminders-write" });
        },
        onSettled: () => {
          void trpcUtils.settings.get.invalidate({ key: MEDICATION_REMINDERS_SETTINGS_KEY });
        },
      },
    );
  };

  const handleAdd = () => {
    const medicationName = draftName.trim();
    if (medicationName.length === 0) {
      setWriteError("Enter a medication name.");
      return;
    }

    const parseResult = medicationReminderSchema.safeParse({
      id: createReminderId(),
      medicationName,
      localTime: draftTime,
      enabled: true,
    });
    if (!parseResult.success) {
      setWriteError("Time must be in HH:mm 24-hour format (e.g., 08:30).");
      return;
    }

    persistReminders([...reminders, parseResult.data]);
    setDraftName("");
    setDraftTime("08:00");
  };

  return (
    <div className="space-y-4">
      {writeError ? (
        <p role="alert" className="text-xs text-red-400">
          {writeError}
        </p>
      ) : null}

      {reminders.length === 0 ? (
        <p className="text-sm text-muted">No medication reminders yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {reminders.map((reminder) => {
            const loggingState = findLatestDoseLoggingState(reminder.medicationName, events);
            const isFocused = focusedReminderId === reminder.id;
            return (
              <li
                key={reminder.id}
                ref={isFocused ? focusedRowRef : undefined}
                className={`py-3 first:pt-0 last:pb-0 ${isFocused ? "rounded bg-accent/10 px-2" : ""}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {reminder.medicationName}
                    </p>
                    <p className="text-xs text-muted">{reminder.localTime}</p>
                    <p className="text-xs text-subtle">
                      {loggingState
                        ? `Latest log: ${formatDoseStatus(loggingState.doseStatus)} · ${formatDateTime(new Date(loggingState.recordedAt))}`
                        : "No imported dose log yet."}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="rounded border border-border-strong px-2 py-1 text-xs text-subtle hover:bg-surface-hover"
                      onClick={() =>
                        persistReminders(
                          reminders.map((item) =>
                            item.id === reminder.id ? { ...item, enabled: !item.enabled } : item,
                          ),
                        )
                      }
                    >
                      {reminder.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      type="button"
                      className="rounded border border-border-strong px-2 py-1 text-xs text-red-400 hover:bg-surface-hover"
                      onClick={() =>
                        persistReminders(reminders.filter((item) => item.id !== reminder.id))
                      }
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <p className="mt-2 text-xs text-muted">
                  {reminder.enabled ? "Reminder enabled" : "Reminder disabled"}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-subtle">Medication name</span>
          <input
            aria-label="Medication name"
            className="w-full rounded border border-border-strong bg-transparent px-3 py-2 text-sm text-foreground"
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            placeholder="Vitamin D3"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-subtle">Daily time</span>
          <input
            aria-label="Daily time"
            type="time"
            className="w-full rounded border border-border-strong bg-transparent px-3 py-2 text-sm text-foreground"
            value={draftTime}
            onChange={(event) => setDraftTime(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="rounded bg-accent px-3 py-2 text-sm text-on-accent hover:bg-accent/90 disabled:opacity-50"
          onClick={handleAdd}
          disabled={setSettingMutation.isPending}
        >
          Add reminder
        </button>
      </div>
    </div>
  );
}
