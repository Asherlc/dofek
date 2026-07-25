import { createContext, type ReactNode, useContext } from "react";
import { useProcessingAlerts } from "../hooks/useProcessingAlerts.ts";

const ProcessingAlertsContext = createContext(0);

export function ProcessingAlertsProvider({ children }: { children: ReactNode }) {
  const alerts = useProcessingAlerts();
  return (
    <ProcessingAlertsContext.Provider value={alerts.data?.alerts.length ?? 0}>
      {children}
    </ProcessingAlertsContext.Provider>
  );
}

export function useActiveProcessingAlertCount(): number {
  return useContext(ProcessingAlertsContext);
}
