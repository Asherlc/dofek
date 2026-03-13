import { createContext, useContext } from "react";
import type { UnitSystem } from "./units.ts";

interface UnitContextValue {
  unitSystem: UnitSystem;
  setUnitSystem: (system: UnitSystem) => void;
}

export const UnitContext = createContext<UnitContextValue>({
  unitSystem: "metric",
  setUnitSystem: () => {},
});

export function useUnitSystem(): UnitContextValue {
  return useContext(UnitContext);
}
