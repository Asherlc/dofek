import { useUnitSystem } from "../lib/unitContext.ts";
import type { UnitSystem } from "../lib/units.ts";

const OPTIONS: { value: UnitSystem; label: string; description: string }[] = [
  { value: "metric", label: "Metric", description: "kg, km, °C" },
  { value: "imperial", label: "Imperial", description: "lbs, mi, °F" },
];

export function UnitSystemToggle() {
  const { unitSystem, setUnitSystem } = useUnitSystem();

  return (
    <div className="flex gap-3">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => setUnitSystem(option.value)}
          className={`flex-1 rounded-lg border px-4 py-3 text-left transition-colors ${
            unitSystem === option.value
              ? "border-cyan-600 bg-cyan-950/40 text-zinc-100"
              : "border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-600"
          }`}
        >
          <div className="text-sm font-medium">{option.label}</div>
          <div className="text-xs text-zinc-500 mt-0.5">{option.description}</div>
        </button>
      ))}
    </div>
  );
}
