import { useState } from "react";
import { z } from "zod";
import { useUnitConverter } from "../lib/unitContext.ts";

const fingerExerciseSchema = z.enum([
  "max_hang",
  "repeater",
  "min_edge",
  "one_arm",
  "campus",
  "no_hang",
]);
const gripPositionSchema = z.enum([
  "half_crimp",
  "full_crimp",
  "open_hand",
  "three_finger_drag",
  "two_finger_pocket",
]);
const lateralitySchema = z.enum(["both", "left", "right"]);
type FingerExercise = z.infer<typeof fingerExerciseSchema>;
type GripPosition = z.infer<typeof gripPositionSchema>;
type Laterality = z.infer<typeof lateralitySchema>;

export interface FingerLoadingSubmission {
  bodyweightKg: number;
  edgeSizeMm: number | null;
  exercise: FingerExercise;
  externalLoadKg: number;
  gripPosition: GripPosition | null;
  holdDurationSeconds: number;
  laterality: Laterality;
  notes: string | null;
  restIntervalSeconds: number;
  setCount: number;
  startedAt: string;
}

export type FingerLoadingPreset = Omit<FingerLoadingSubmission, "startedAt">;

const exerciseOptions: Array<{ label: string; value: FingerExercise }> = [
  { label: "Max hang", value: "max_hang" },
  { label: "Repeater", value: "repeater" },
  { label: "Minimum edge", value: "min_edge" },
  { label: "One arm", value: "one_arm" },
  { label: "Campus", value: "campus" },
  { label: "No hang", value: "no_hang" },
];
const gripOptions: Array<{ label: string; value: GripPosition }> = [
  { label: "Half crimp", value: "half_crimp" },
  { label: "Full crimp", value: "full_crimp" },
  { label: "Open hand", value: "open_hand" },
  { label: "Three-finger drag", value: "three_finger_drag" },
  { label: "Two-finger pocket", value: "two_finger_pocket" },
];

export function FingerLoadingLog({
  errorMessage,
  latest,
  loading,
  onSubmit,
  submitting,
}: {
  errorMessage: string | null;
  latest: FingerLoadingPreset | null;
  loading: boolean;
  onSubmit: (input: FingerLoadingSubmission) => void;
  submitting: boolean;
}) {
  const units = useUnitConverter();
  const [exercise, setExercise] = useState<FingerExercise>("max_hang");
  const [edgeSizeMm, setEdgeSizeMm] = useState(20);
  const [gripPosition, setGripPosition] = useState<GripPosition>("half_crimp");
  const [bodyweight, setBodyweight] = useState(70);
  const [externalLoad, setExternalLoad] = useState(0);
  const [laterality, setLaterality] = useState<Laterality>("both");
  const [setCount, setSetCount] = useState(5);
  const [holdDurationSeconds, setHoldDurationSeconds] = useState(10);
  const [restIntervalSeconds, setRestIntervalSeconds] = useState(180);
  const [notes, setNotes] = useState("");

  const weightToKg = (weight: number) => (units.weightLabel === "lbs" ? weight / 2.20462 : weight);

  function applyPreset(preset: FingerLoadingPreset): void {
    setExercise(preset.exercise);
    setEdgeSizeMm(preset.edgeSizeMm ?? 20);
    setGripPosition(preset.gripPosition ?? "half_crimp");
    setBodyweight(units.convertWeight(preset.bodyweightKg));
    setExternalLoad(units.convertWeight(preset.externalLoadKg));
    setLaterality(preset.laterality);
    setSetCount(preset.setCount);
    setHoldDurationSeconds(preset.holdDurationSeconds);
    setRestIntervalSeconds(preset.restIntervalSeconds);
    setNotes(preset.notes ?? "");
  }

  if (loading) {
    return <p className="text-sm text-muted">Loading previous finger session…</p>;
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          bodyweightKg: weightToKg(bodyweight),
          edgeSizeMm,
          exercise,
          externalLoadKg: weightToKg(externalLoad),
          gripPosition,
          holdDurationSeconds,
          laterality,
          notes: notes.trim() || null,
          restIntervalSeconds,
          setCount,
          startedAt: new Date().toISOString(),
        });
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Log the raw protocol; effective load is calculated on the server.
        </p>
        <button
          aria-label="Repeat previous finger session"
          className="rounded border border-border px-3 py-2 text-xs disabled:opacity-50"
          disabled={latest === null}
          onClick={() => latest && applyPreset(latest)}
          type="button"
        >
          Repeat previous
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="Exercise">
          <select
            aria-label="Exercise"
            className="input"
            onChange={(event) => setExercise(fingerExerciseSchema.parse(event.target.value))}
            value={exercise}
          >
            {exerciseOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <NumberField label="Edge size (mm)" min={1} value={edgeSizeMm} onChange={setEdgeSizeMm} />
        <Field label="Grip position">
          <select
            aria-label="Grip position"
            className="input"
            onChange={(event) => setGripPosition(gripPositionSchema.parse(event.target.value))}
            value={gripPosition}
          >
            {gripOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Laterality">
          <select
            aria-label="Laterality"
            className="input"
            onChange={(event) => setLaterality(lateralitySchema.parse(event.target.value))}
            value={laterality}
          >
            <option value="both">Both hands</option>
            <option value="left">Left hand</option>
            <option value="right">Right hand</option>
          </select>
        </Field>
        <NumberField
          label={`Bodyweight (${units.weightLabel})`}
          min={1}
          step={0.1}
          value={bodyweight}
          onChange={setBodyweight}
        />
        <NumberField
          label={`Added (+) or removed (-) load (${units.weightLabel})`}
          step={0.1}
          value={externalLoad}
          onChange={setExternalLoad}
        />
        <NumberField label="Sets" min={1} value={setCount} onChange={setSetCount} />
        <NumberField
          label="Hold duration (seconds)"
          min={0.1}
          step={0.1}
          value={holdDurationSeconds}
          onChange={setHoldDurationSeconds}
        />
        <NumberField
          label="Rest interval (seconds)"
          min={0}
          value={restIntervalSeconds}
          onChange={setRestIntervalSeconds}
        />
      </div>
      <Field label="Notes">
        <textarea
          aria-label="Notes"
          className="input min-h-20"
          maxLength={500}
          onChange={(event) => setNotes(event.target.value)}
          value={notes}
        />
      </Field>
      {errorMessage ? (
        <p className="text-sm text-red-400" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <button
        aria-label="Save finger session"
        className="rounded bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-50"
        disabled={submitting}
        type="submit"
      >
        {submitting ? "Saving…" : "Save finger session"}
      </button>
    </form>
  );
}

function Field({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="flex flex-col gap-1 text-xs text-muted">
      <span>{label}</span>
      {children}
    </div>
  );
}

function NumberField({
  label,
  max,
  min,
  onChange,
  step = 1,
  value,
}: {
  label: string;
  max?: number;
  min?: number;
  onChange: (value: number) => void;
  step?: number;
  value: number;
}) {
  return (
    <Field label={label}>
      <input
        aria-label={label}
        className="input"
        max={max}
        min={min}
        onChange={(event) => onChange(event.target.valueAsNumber)}
        required
        step={step}
        type="number"
        value={value}
      />
    </Field>
  );
}
