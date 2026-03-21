import { createContext, useContext } from "react";
import type { UnitSystem } from "./units.ts";
import { UnitConverter } from "./units.ts";

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

/**
 * Hook that returns a UnitConverter for the current unit system.
 */
export function useUnitConverter(): UnitConverter {
  const { unitSystem } = useContext(UnitContext);
  return new UnitConverter(unitSystem);
}
