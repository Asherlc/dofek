import { useCallback, useEffect, useState } from "react";
import { trpc } from "../lib/trpc.ts";
import { UnitContext } from "../lib/unitContext.ts";
import { detectUnitSystem, type UnitSystem } from "../lib/units.ts";

const SETTINGS_KEY = "unitSystem";

function getDefaultUnitSystem(): UnitSystem {
  const locale = navigator.language || "en-US";
  return detectUnitSystem(locale);
}

export function UnitProvider({ children }: { children: React.ReactNode }) {
  const [unitSystem, setUnitSystemState] = useState<UnitSystem>(getDefaultUnitSystem);

  const setting = trpc.settings.get.useQuery({ key: SETTINGS_KEY });
  const mutation = trpc.settings.set.useMutation();
  const utils = trpc.useUtils();

  // Once the server setting loads, apply it (overrides locale default)
  useEffect(() => {
    if (setting.data?.value) {
      const value = String(setting.data.value);
      if (value === "metric" || value === "imperial") {
        setUnitSystemState(value);
      }
    }
  }, [setting.data]);

  const setUnitSystem = useCallback(
    (system: UnitSystem) => {
      setUnitSystemState(system);
      mutation.mutate(
        { key: SETTINGS_KEY, value: system },
        { onSuccess: () => utils.settings.get.invalidate({ key: SETTINGS_KEY }) },
      );
    },
    [mutation, utils],
  );

  return <UnitContext value={{ unitSystem, setUnitSystem }}>{children}</UnitContext>;
}
