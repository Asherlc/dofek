import type { UnitSystem } from "@dofek/format/units";
import { UnitConverter } from "@dofek/format/units";
import { createContext, useContext, useMemo } from "react";

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
  return useMemo(() => new UnitConverter(unitSystem), [unitSystem]);
}
