import { trpc } from "./trpc";

export {
  convertDistance,
  convertElevation,
  convertPace,
  convertSpeed,
  convertTemperature,
  convertWeight,
  distanceLabel,
  elevationLabel,
  paceLabel,
  speedLabel,
  temperatureLabel,
  weightLabel,
} from "@dofek/format/units";
export type { UnitSystem } from "@dofek/format/units";

/**
 * Hook that fetches the user's unit system preference from the server.
 * Falls back to "metric" if no preference is set.
 */
export function useUnitSystem() {
  const setting = trpc.settings.get.useQuery({ key: "unitSystem" });
  const value = setting.data?.value;
  if (value === "imperial" || value === "metric") return value;
  return "metric";
}
