import {
  parseWhoopWearLocation,
  WHOOP_WEAR_LOCATION_SETTING_KEY,
  WHOOP_WEAR_LOCATIONS,
  type WhoopWearLocation,
} from "@dofek/providers/whoop";
import { useEffect, useRef, useState } from "react";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";

export function WhoopWearLocationPicker() {
  const setting = trpc.settings.get.useQuery({ key: WHOOP_WEAR_LOCATION_SETTING_KEY });
  const setSettingMutation = trpc.settings.set.useMutation();
  const trpcUtils = trpc.useUtils();
  const [writeError, setWriteError] = useState<string | null>(null);
  const lastReadError = useRef<unknown>(null);
  const currentLocation = parseWhoopWearLocation(setting.data?.value);

  useEffect(() => {
    if (setting.error && lastReadError.current !== setting.error) {
      lastReadError.current = setting.error;
      captureException(setting.error, { context: "whoop-wear-location-read" });
    }
  }, [setting.error]);

  const handleChange = (location: WhoopWearLocation) => {
    const previousSetting = trpcUtils.settings.get.getData({
      key: WHOOP_WEAR_LOCATION_SETTING_KEY,
    });
    trpcUtils.settings.get.setData(
      { key: WHOOP_WEAR_LOCATION_SETTING_KEY },
      { key: WHOOP_WEAR_LOCATION_SETTING_KEY, value: location },
    );
    setWriteError(null);
    setSettingMutation.mutate(
      { key: WHOOP_WEAR_LOCATION_SETTING_KEY, value: location },
      {
        onError: (error) => {
          trpcUtils.settings.get.setData({ key: WHOOP_WEAR_LOCATION_SETTING_KEY }, previousSetting);
          setWriteError(error.message);
          captureException(error, { context: "whoop-wear-location-write" });
        },
        onSettled: () => {
          void trpcUtils.settings.get.invalidate({ key: WHOOP_WEAR_LOCATION_SETTING_KEY });
        },
      },
    );
  };

  return (
    <section className="card p-4 space-y-3">
      <div>
        <h2 className="text-sm font-medium text-foreground">Wear Location</h2>
        <p className="text-xs text-subtle mt-0.5">
          Where do you wear your WHOOP? This helps us interpret your sensor data.
        </p>
      </div>
      {(writeError ?? setting.error?.message) && (
        <p role="alert" className="text-xs text-red-400">
          {writeError ?? setting.error?.message}
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {WHOOP_WEAR_LOCATIONS.map((location) => (
          <button
            key={location.id}
            type="button"
            onClick={() => handleChange(location.id)}
            className={`text-left px-3 py-2.5 rounded-lg border transition-colors ${
              currentLocation === location.id
                ? "border-emerald-500 bg-emerald-500/10"
                : "border-border-strong bg-accent/5 hover:bg-surface-hover"
            }`}
          >
            <div className="text-xs font-medium text-foreground">{location.label}</div>
            <div className="text-xs text-subtle mt-0.5">{location.description}</div>
          </button>
        ))}
      </div>
    </section>
  );
}
