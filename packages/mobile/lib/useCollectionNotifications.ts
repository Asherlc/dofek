import { useEffect } from "react";
import { Alert, AppState } from "react-native";
import {
  disableCollectionNotifications,
  enableCollectionNotifications,
} from "../modules/background-refresh";
import { captureException } from "./telemetry";

/** Native alerts also run after background launches; only permission prompts need the foreground. */
export function useCollectionNotifications(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) {
      disableCollectionNotifications();
      return;
    }

    let active = true;
    const enable = async (requestPermission: boolean) => {
      try {
        await enableCollectionNotifications(requestPermission);
      } catch (error: unknown) {
        captureException(error, { source: "collection-notifications-enable" });
        if (active && AppState.currentState === "active") {
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
      disableCollectionNotifications();
    };
  }, [enabled]);
}
