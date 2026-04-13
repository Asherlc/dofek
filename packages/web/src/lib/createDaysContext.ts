import { createContext, useContext } from "react";

interface DaysContextValue {
  days: number;
  setDays: (days: number) => void;
}

export function createDaysContext(defaultDays: number) {
  const DaysContext = createContext<DaysContextValue>({
    days: defaultDays,
    setDays: () => {},
  });

  function useDays(): DaysContextValue {
    return useContext(DaysContext);
  }

  return { DaysContext, useDays };
}
