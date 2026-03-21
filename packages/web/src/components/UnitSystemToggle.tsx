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
              ? "border-accent bg-accent/10 text-foreground"
              : "border-border-strong bg-accent/10 text-muted hover:border-border-strong"
          }`}
        >
          <div className="text-sm font-medium">{option.label}</div>
          <div className="text-xs text-subtle mt-0.5">{option.description}</div>
        </button>
      ))}
    </div>
  );
}
