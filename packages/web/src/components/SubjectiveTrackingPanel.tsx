import { useEffect, useMemo, useState } from "react";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";

type SymptomDraft = {
  bodyRegionId: string;
  kind: "soreness" | "stiffness" | "tenderness";
  score: number;
};

function isSymptomKind(value: string): value is SymptomDraft["kind"] {
  return value === "soreness" || value === "stiffness" || value === "tenderness";
}

function today(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value}`;
}

export function SubjectiveTrackingPanel() {
  const date = useMemo(today, []);
  const utils = trpc.useUtils();
  const checkIn = trpc.subjective.checkIn.useQuery({ date });
  const regions = trpc.subjective.regions.useQuery();
  const injuries = trpc.subjective.injuries.useQuery();
  const [symptoms, setSymptoms] = useState<SymptomDraft[]>([]);
  const [selectedRegion, setSelectedRegion] = useState("");
  const [selectedKind, setSelectedKind] = useState<SymptomDraft["kind"]>("soreness");
  const [selectedScore, setSelectedScore] = useState(1);
  const [injuryDescription, setInjuryDescription] = useState("");
  const save = trpc.subjective.saveCheckIn.useMutation({
    onSuccess: () => {
      void utils.subjective.checkIn.invalidate({ date });
      void utils.subjective.timeline.invalidate();
    },
    onError: (error) => captureException(error, { operation: "subjective.saveCheckIn" }),
  });
  const createInjury = trpc.subjective.createInjury.useMutation({
    onSuccess: () => {
      setInjuryDescription("");
      void utils.subjective.injuries.invalidate();
    },
    onError: (error) => captureException(error, { operation: "subjective.createInjury" }),
  });

  useEffect(() => {
    if (!checkIn.data) return;
    setSymptoms(
      checkIn.data.symptoms.map((symptom) => ({
        bodyRegionId: symptom.body_region_id,
        kind: symptom.kind,
        score: symptom.score,
      })),
    );
  }, [checkIn.data]);

  const regionOptions = regions.data ?? [];
  const addSymptom = () => {
    if (!selectedRegion) return;
    setSymptoms((current) => {
      const withoutExisting = current.filter(
        (symptom) => !(symptom.bodyRegionId === selectedRegion && symptom.kind === selectedKind),
      );
      return [
        ...withoutExisting,
        { bodyRegionId: selectedRegion, kind: selectedKind, score: selectedScore },
      ];
    });
  };
  const saveSymptoms = () => save.mutate({ date, symptoms });

  return (
    <div className="space-y-4">
      <div className="card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-medium">Today&apos;s body check-in</h3>
            <p className="text-xs text-muted">{date}. No check-in means not logged.</p>
          </div>
          <span className="text-xs text-dim">
            {checkIn.data?.logged ? (symptoms.length === 0 ? "All clear" : "Logged") : "Not logged"}
          </span>
        </div>
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-xs text-muted">
            Body region
            <select
              aria-label="Body region"
              className="block mt-1 rounded border border-border bg-surface px-2 py-1 text-sm"
              value={selectedRegion}
              onChange={(event) => setSelectedRegion(event.target.value)}
            >
              <option value="">Choose region</option>
              {regionOptions.map((region) => (
                <option key={region.id} value={region.id}>
                  {region.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted">
            Symptom
            <select
              aria-label="Symptom type"
              className="block mt-1 rounded border border-border bg-surface px-2 py-1 text-sm"
              value={selectedKind}
              onChange={(event) => {
                if (isSymptomKind(event.target.value)) setSelectedKind(event.target.value);
              }}
            >
              <option value="soreness">Soreness</option>
              <option value="stiffness">Stiffness</option>
              <option value="tenderness">Tenderness</option>
            </select>
          </label>
          <label className="text-xs text-muted">
            Score (1–10)
            <input
              aria-label="Symptom score"
              className="block mt-1 w-20 rounded border border-border bg-surface px-2 py-1 text-sm"
              type="number"
              min={1}
              max={10}
              value={selectedScore}
              onChange={(event) => setSelectedScore(Number(event.target.value))}
            />
          </label>
          <button
            type="button"
            className="rounded border border-border px-3 py-1.5 text-sm"
            onClick={addSymptom}
          >
            Add symptom
          </button>
        </div>
        {symptoms.length > 0 && (
          <ul className="text-sm space-y-1">
            {symptoms.map((symptom) => (
              <li key={`${symptom.bodyRegionId}:${symptom.kind}`} className="flex justify-between">
                <span>
                  {regionOptions.find((region) => region.id === symptom.bodyRegionId)?.label ??
                    symptom.bodyRegionId}{" "}
                  · {symptom.kind}
                </span>
                <span>{symptom.score}/10</span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded bg-accent/15 px-3 py-1.5 text-sm text-accent"
            onClick={saveSymptoms}
            disabled={save.isPending}
          >
            Save check-in
          </button>
          <button
            type="button"
            className="rounded border border-border px-3 py-1.5 text-sm"
            onClick={() => save.mutate({ date, symptoms: [] })}
            disabled={save.isPending}
          >
            Log all clear
          </button>
        </div>
        {save.error && <p className="text-sm text-red-400">{save.error.message}</p>}
      </div>

      <div className="card p-4 space-y-3">
        <h3 className="font-medium">Injury and niggle timeline</h3>
        <div className="flex gap-2">
          <input
            aria-label="Injury description"
            className="flex-1 rounded border border-border bg-surface px-2 py-1 text-sm"
            placeholder="Describe an injury or niggle"
            value={injuryDescription}
            onChange={(event) => setInjuryDescription(event.target.value)}
          />
          <button
            type="button"
            className="rounded border border-border px-3 py-1.5 text-sm"
            disabled={!injuryDescription.trim() || !selectedRegion || createInjury.isPending}
            onClick={() =>
              createInjury.mutate({
                kind: "niggle",
                bodyRegionId: selectedRegion,
                onsetDate: date,
                resolvedDate: null,
                severity: selectedScore,
                description: injuryDescription.trim(),
              })
            }
          >
            Add niggle
          </button>
        </div>
        {createInjury.error && <p className="text-sm text-red-400">{createInjury.error.message}</p>}
        {injuries.data?.length ? (
          <ul className="space-y-1 text-sm">
            {injuries.data.map((injury) => (
              <li key={injury.id}>
                {injury.kind} · {injury.description} · {injury.severity}/10 · {injury.onset_date}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-dim">No injury events logged.</p>
        )}
      </div>
    </div>
  );
}
