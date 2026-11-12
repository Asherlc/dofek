import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import type {
  HealthKitManualSyncController,
  HealthKitManualSyncState,
} from "./health-kit-manual-sync";

type HealthKitManualSyncOwner = Pick<
  HealthKitManualSyncController,
  "userId" | "getSnapshot" | "subscribe" | "start" | "resume" | "retire"
>;

const INITIAL_STATE: HealthKitManualSyncState = {
  status: "idle",
  message: null,
  completedStageCount: 0,
  totalStageCount: 0,
  error: null,
};

const HealthKitManualSyncContext = createContext<HealthKitManualSyncOwner | null>(null);

export function HealthKitManualSyncProvider({
  controller,
  children,
}: {
  controller: HealthKitManualSyncOwner | null;
  children: ReactNode;
}) {
  return (
    <HealthKitManualSyncContext.Provider value={controller}>
      {children}
    </HealthKitManualSyncContext.Provider>
  );
}

export function useHealthKitManualSync(): {
  controller: HealthKitManualSyncOwner | null;
  state: HealthKitManualSyncState;
} {
  const controller = useContext(HealthKitManualSyncContext);
  const state = useSyncExternalStore(
    controller?.subscribe ?? (() => () => undefined),
    controller?.getSnapshot ?? (() => INITIAL_STATE),
    () => INITIAL_STATE,
  );
  return { controller, state };
}
