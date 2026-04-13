import { createContext, useContext } from "react";

interface BodyDaysContextValue {
  days: number;
  setDays: (days: number) => void;
}

export const BodyDaysContext = createContext<BodyDaysContextValue>({
  days: 30,
  setDays: () => {},
});

export function useBodyDays(): BodyDaysContextValue {
  return useContext(BodyDaysContext);
}
