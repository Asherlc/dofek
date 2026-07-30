import { createContext, useContext } from "react";
import type { TimeRangeDays } from "./timeRange.ts";

interface BodyDaysContextValue {
  days: TimeRangeDays;
  description: string;
  setDays: (days: TimeRangeDays) => void;
}

class MissingBodyDaysProviderError extends Error {
  constructor() {
    super("useBodyDays must be used within BodyDaysContext.Provider");
    this.name = "MissingBodyDaysProviderError";
  }
}

export const BodyDaysContext = createContext<BodyDaysContextValue | null>(null);

export function useBodyDays(): BodyDaysContextValue {
  const context = useContext(BodyDaysContext);
  if (context === null) {
    throw new MissingBodyDaysProviderError();
  }
  return context;
}
