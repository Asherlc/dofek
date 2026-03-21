import { UnitConverter } from "@dofek/format/units";
import { trpc } from "./trpc";

export { UnitConverter } from "@dofek/format/units";
export type { UnitSystem } from "@dofek/format/units";

/**
 * Hook that creates a UnitConverter for the user's unit system preference.
 * Falls back to "metric" if no preference is set.
 */
export function useUnitConverter(): UnitConverter {
  const setting = trpc.settings.get.useQuery({ key: "unitSystem" });
  const value = setting.data?.value;
  const system = value === "imperial" || value === "metric" ? value : "metric";
  return new UnitConverter(system);
}
