import { detectUnitSystem, type UnitSystem } from "@dofek/format/units";
import { useCallback, useEffect, useRef, useState } from "react";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";
import { UnitContext } from "../lib/unitContext.ts";

const SETTINGS_KEY = "unitSystem";

function getDefaultUnitSystem(): UnitSystem {
  const locale = navigator.language || "en-US";
  return detectUnitSystem(locale);
}

export function UnitProvider({
  children,
  settingsEnabled,
}: {
  children: React.ReactNode;
  settingsEnabled: boolean;
}) {
  const [unitSystem, setUnitSystemState] = useState<UnitSystem>(getDefaultUnitSystem);
  const [writeError, setWriteError] = useState<string | null>(null);
  const currentUnitSystem = useRef(unitSystem);
  const lastReadError = useRef<unknown>(null);

  const setting = trpc.settings.get.useQuery({ key: SETTINGS_KEY }, { enabled: settingsEnabled });
  const mutation = trpc.settings.set.useMutation();
  const utils = trpc.useUtils();

  // Once the server setting loads, apply it (overrides locale default)
  useEffect(() => {
    if (setting.data?.value) {
      const value = String(setting.data.value);
      if (value === "metric" || value === "imperial") {
        currentUnitSystem.current = value;
        setUnitSystemState(value);
      }
    }
  }, [setting.data]);

  useEffect(() => {
    if (setting.error && lastReadError.current !== setting.error) {
      lastReadError.current = setting.error;
      captureException(setting.error, { context: "unit-system-read" });
    }
  }, [setting.error]);

  const setUnitSystem = useCallback(
    (system: UnitSystem) => {
      const previousSystem = currentUnitSystem.current;
      const previousSetting = utils.settings.get.getData({ key: SETTINGS_KEY });
      currentUnitSystem.current = system;
      setUnitSystemState(system);
      utils.settings.get.setData({ key: SETTINGS_KEY }, { key: SETTINGS_KEY, value: system });
      setWriteError(null);
      mutation.mutate(
        { key: SETTINGS_KEY, value: system },
        {
          onError: (error) => {
            currentUnitSystem.current = previousSystem;
            setUnitSystemState(previousSystem);
            utils.settings.get.setData({ key: SETTINGS_KEY }, previousSetting);
            setWriteError(error.message);
            captureException(error, { context: "unit-system-write" });
          },
          onSettled: () => {
            void utils.settings.get.invalidate({ key: SETTINGS_KEY });
          },
        },
      );
    },
    [mutation, utils],
  );

  return (
    <>
      <UnitContext value={{ unitSystem, setUnitSystem }}>{children}</UnitContext>
      {(writeError ?? setting.error?.message) && (
        <p
          role="alert"
          className="fixed bottom-4 left-4 z-50 rounded bg-red-950 px-3 py-2 text-sm text-red-200"
        >
          {writeError ?? setting.error?.message}
        </p>
      )}
    </>
  );
}
