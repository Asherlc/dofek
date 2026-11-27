import { useEffect, useRef } from "react";
import { Alert, AppState } from "react-native";
import {
  disableCollectionNotifications,
  enableCollectionNotifications,
} from "../modules/background-refresh";
import { captureException, logger } from "./telemetry";

/** Current-owner admission so a stale AppState listener cannot arm alerts after retirement. */
interface CollectionNotificationSessionAdmission {
  sessionOwnerNonce: string | null;
  isCurrentSessionOwner: (nonce: string | null) => boolean;
}

/** Undefined preserves native monitoring until session and collection readiness are known. */
export function useCollectionNotifications(
  enabled: boolean | undefined,
  { sessionOwnerNonce, isCurrentSessionOwner }: CollectionNotificationSessionAdmission,
): void {
  const denialExplained = useRef(false);
  useEffect(() => {
    if (enabled === undefined) return;
    if (enabled === false) {
      void disableCollectionNotifications();
      denialExplained.current = false;
      return;
    }

    let active = true;
    let enableAttempt = 0;
    const isAdmitted = () => active && isCurrentSessionOwner(sessionOwnerNonce);
    const enable = async (requestPermission: boolean) => {
      if (!isAdmitted()) return;
      const attempt = ++enableAttempt;
      try {
        const granted = await enableCollectionNotifications(requestPermission);
        if (attempt !== enableAttempt || !isAdmitted()) return;
        logger.info("collection-notifications", "Native collection notification check completed", {
          event: "collection_notifications_enable_completed",
          requestPermission,
          granted,
        });
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
          attempt === enableAttempt &&
          isAdmitted() &&
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
  }, [enabled, isCurrentSessionOwner, sessionOwnerNonce]);
}
