import { useEffect, useRef } from "react";
import { Alert, AppState } from "react-native";
import {
  disableCollectionNotifications,
  enableCollectionNotifications,
} from "../modules/background-refresh";
import { captureException } from "./telemetry";

/** Undefined preserves native monitoring until session and collection readiness are known. */
export function useCollectionNotifications(enabled: boolean | undefined): void {
  const denialExplained = useRef(false);
  useEffect(() => {
    if (enabled === undefined) return;
    if (enabled === false) {
      disableCollectionNotifications();
      denialExplained.current = false;
      return;
    }

    let active = true;
    let enableAttempt = 0;
    const enable = async (requestPermission: boolean) => {
      const attempt = ++enableAttempt;
      try {
        const granted = await enableCollectionNotifications(requestPermission);
        if (!active || attempt !== enableAttempt) return;
        if (granted) {
          denialExplained.current = false;
        } else if (
          requestPermission &&
          AppState.currentState === "active" &&
          !denialExplained.current
        ) {
          denialExplained.current = true;
          Alert.alert(
            "Notifications unavailable",
            "Enable notifications for Dofek in iOS Settings to receive WHOOP disconnect and collection alerts.",
          );
        }
      } catch (error: unknown) {
        captureException(error, { source: "collection-notifications-enable" });
        if (
          active &&
          attempt === enableAttempt &&
          requestPermission &&
          AppState.currentState === "active"
        ) {
          Alert.alert(
            "Notifications unavailable",
            error instanceof Error
              ? error.message
              : "Open iOS Settings to check notification access.",
          );
        }
      }
    };

    void enable(AppState.currentState === "active");
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void enable(true);
    });

    return () => {
      active = false;
      subscription.remove();
    };
  }, [enabled]);
}
