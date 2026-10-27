import { AppState } from "react-native";
import { z } from "zod";
import { getDiagnostics } from "../modules/background-refresh";
import { captureException, logger } from "./telemetry";

const diagnosticEvent = z.object({
  eventId: z.uuid(),
  occurredAt: z.iso.datetime(),
  nativeSessionId: z.uuid(),
  processId: z.number().int().nonnegative(),
  event: z.enum([
    "registration_result",
    "schedule_requested",
    "schedule_succeeded",
    "schedule_failed",
    "task_launched",
    "listener_changed",
    "bridge_dispatched",
    "js_received",
    "completion_requested",
    "task_completed",
    "task_expired",
  ]),
  taskId: z.uuid().optional(),
  taskIdentifier: z.string().optional(),
  earliestBeginAt: z.iso.datetime().optional(),
  success: z.boolean().optional(),
  reason: z.string().optional(),
  backgroundRefreshStatus: z.string().optional(),
  lowPowerModeEnabled: z.boolean().optional(),
  errorDomain: z.string().optional(),
  errorCode: z.number().int().optional(),
  errorDescription: z.string().optional(),
});
const diagnosticHistory = z.object({
  events: z.array(diagnosticEvent).max(64),
  overflowCount: z.number().int().nonnegative(),
});

type Trigger = "initial" | "foreground" | "received" | "settled";

/** Replay metadata through the authenticated telemetry lifetime; native account ownership is unknown. */
export function createBackgroundRefreshDiagnostics() {
  let active = true;
  let reportedEventIds = new Set<string>();
  const report = (trigger: Trigger): void => {
    if (!active) return;
    try {
      const parsed = diagnosticHistory.safeParse(getDiagnostics());
      // Zod's error can retain the rejected input. Report a fixed message instead.
      if (!parsed.success) throw new Error("Invalid native background refresh diagnostics");
      // Prune first so even a telemetry failure cannot retain stale IDs across snapshots.
      const retainedIds = new Set(parsed.data.events.map((entry) => entry.eventId));
      reportedEventIds = new Set([...reportedEventIds].filter((id) => retainedIds.has(id)));
      for (const entry of parsed.data.events) {
        if (reportedEventIds.has(entry.eventId)) continue;
        const { event, occurredAt, ...fields } = entry;
        logger.info("background-refresh", "native_background_refresh_event", {
          ...fields,
          event: "native_background_refresh_event",
          nativeEvent: event,
          nativeOccurredAt: occurredAt,
          diagnosticAccountProvenance: "unknown",
          historyOverflowCount: parsed.data.overflowCount,
          trigger,
        });
        reportedEventIds.add(entry.eventId);
      }
    } catch (error: unknown) {
      captureException(error, { source: "background-refresh-diagnostics", trigger });
    }
  };
  report("initial");
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") report("foreground");
  });
  return {
    report,
    remove(): void {
      active = false;
      reportedEventIds.clear();
      subscription.remove();
    },
  };
}
