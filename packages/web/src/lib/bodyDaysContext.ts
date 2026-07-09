import { createContext, useContext } from "react";
import type { TimeRangeDays } from "./timeRange.ts";

interface BodyDaysContextValue {
  days: TimeRangeDays;
  setDays: (days: TimeRangeDays) => void;
}

export const BodyDaysContext = createContext<BodyDaysContextValue>({
  days: 30,
  setDays: () => {},
});

export function useBodyDays(): BodyDaysContextValue {
  return useContext(BodyDaysContext);
}
