import { formatDateYmd } from "@dofek/format/format";
import { useEffect, useMemo, useRef, useState } from "react";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

type SymptomDraft = {
  bodyRegionId: string;
  kind: "soreness" | "stiffness" | "tenderness";
  score: number;
};

type InjuryKind = "injury" | "niggle";

function isSymptomKind(value: string): value is SymptomDraft["kind"] {
  return value === "soreness" || value === "stiffness" || value === "tenderness";
}

function isInjuryKind(value: string): value is InjuryKind {
  return value === "injury" || value === "niggle";
}

export function SubjectiveTrackingPanel() {
  const date = useMemo(() => formatDateYmd(), []);
  const utils = trpc.useUtils();
  const checkIn = trpc.subjective.checkIn.useQuery({ date });
  const regions = trpc.subjective.regions.useQuery();
  const injuries = trpc.subjective.injuries.useQuery();
  const [symptoms, setSymptoms] = useState<SymptomDraft[]>([]);
  const [selectedRegion, setSelectedRegion] = useState("");
  const [selectedKind, setSelectedKind] = useState<SymptomDraft["kind"]>("soreness");
  const [selectedScore, setSelectedScore] = useState(1);
  const [selectedInjuryKind, setSelectedInjuryKind] = useState<InjuryKind>("niggle");
  const [selectedInjurySeverity, setSelectedInjurySeverity] = useState(0);
  const [injuryOnsetDate, setInjuryOnsetDate] = useState(date);
  const [injuryResolvedDate, setInjuryResolvedDate] = useState<string | null>(null);
  const [injuryDescription, setInjuryDescription] = useState("");
  const initializedCheckInRef = useRef(false);
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
      setInjuryOnsetDate(date);
      setInjuryResolvedDate(null);
      void utils.subjective.injuries.invalidate();
    },
    onError: (error) => captureException(error, { operation: "subjective.createInjury" }),
  });

  useEffect(() => {
    if (!checkIn.data || initializedCheckInRef.current) return;
    initializedCheckInRef.current = true;
    setSymptoms(
      checkIn.data.symptoms.map((symptom) => ({
        bodyRegionId: symptom.body_region_id,
        kind: symptom.kind,
        score: symptom.score,
      })),
    );
  }, [checkIn.data]);

  const regionOptions = regions.data ?? [];
  const checkInReady = checkIn.data !== undefined && !checkIn.error;
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
        {checkIn.isLoading && checkIn.data === undefined ? (
          <QueryStatePanel variant="loading" contextLabel="Body check-in" height={96} />
        ) : checkIn.error && checkIn.data === undefined ? (
          <QueryStatePanel error={checkIn.error} contextLabel="Body check-in" height={96} />
        ) : (
          <>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium">Today&apos;s body check-in</h3>
                <p className="text-xs text-muted">{date}. No check-in means not logged.</p>
              </div>
              <span className="text-xs text-dim">
                {checkIn.data?.logged
                  ? symptoms.length === 0
                    ? "All clear"
                    : "Logged"
                  : "Not logged"}
              </span>
            </div>
            {checkIn.error ? <QueryStatePanel error={checkIn.error} height={72} /> : null}
            {regions.isLoading && regions.data === undefined ? (
              <QueryStatePanel variant="loading" contextLabel="Body regions" height={96} />
            ) : regions.error && regions.data === undefined ? (
              <QueryStatePanel error={regions.error} contextLabel="Body regions" height={96} />
            ) : (
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
                    onChange={(event) => {
                      const parsed = Number(event.target.value);
                      setSelectedScore(Math.min(10, Math.max(1, parsed)));
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="rounded border border-border px-3 py-1.5 text-sm"
                  onClick={addSymptom}
                  disabled={!checkInReady}
                >
                  Add symptom
                </button>
              </div>
            )}
            {symptoms.length > 0 && (
              <ul className="text-sm space-y-1">
                {symptoms.map((symptom) => (
                  <li
                    key={`${symptom.bodyRegionId}:${symptom.kind}`}
                    className="flex justify-between"
                  >
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
                disabled={!checkInReady || save.isPending}
              >
                Save check-in
              </button>
              <button
                type="button"
                className="rounded border border-border px-3 py-1.5 text-sm"
                onClick={() => save.mutate({ date, symptoms: [] })}
                disabled={!checkInReady || save.isPending}
              >
                Log all clear
              </button>
            </div>
            {save.error && <p className="text-sm text-red-400">{save.error.message}</p>}
          </>
        )}
      </div>

      <div className="card p-4 space-y-3">
        <h3 className="font-medium">Injury and niggle timeline</h3>
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-xs text-muted">
            Event type
            <select
              aria-label="Injury type"
              className="block mt-1 rounded border border-border bg-surface px-2 py-1 text-sm"
              value={selectedInjuryKind}
              onChange={(event) => {
                if (isInjuryKind(event.target.value)) setSelectedInjuryKind(event.target.value);
              }}
            >
              <option value="niggle">Niggle</option>
              <option value="injury">Injury</option>
            </select>
          </label>
          <label className="text-xs text-muted">
            Severity (0–10)
            <input
              aria-label="Injury severity"
              className="block mt-1 w-20 rounded border border-border bg-surface px-2 py-1 text-sm"
              type="number"
              min={0}
              max={10}
              value={selectedInjurySeverity}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                setSelectedInjurySeverity(Math.min(10, Math.max(0, parsed)));
              }}
            />
          </label>
          <label className="text-xs text-muted">
            Onset date
            <input
              aria-label="Injury onset date"
              className="block mt-1 rounded border border-border bg-surface px-2 py-1 text-sm"
              type="date"
              value={injuryOnsetDate}
              onChange={(event) => setInjuryOnsetDate(event.target.value)}
            />
          </label>
          <label className="text-xs text-muted">
            Resolution date
            <input
              aria-label="Injury resolution date"
              className="block mt-1 rounded border border-border bg-surface px-2 py-1 text-sm"
              type="date"
              value={injuryResolvedDate ?? ""}
              onChange={(event) => setInjuryResolvedDate(event.target.value || null)}
            />
          </label>
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
                kind: selectedInjuryKind,
                bodyRegionId: selectedRegion,
                onsetDate: injuryOnsetDate,
                resolvedDate: injuryResolvedDate,
                severity: selectedInjurySeverity,
                description: injuryDescription.trim(),
              })
            }
          >
            Add {selectedInjuryKind}
          </button>
        </div>
        {createInjury.error && <p className="text-sm text-red-400">{createInjury.error.message}</p>}
        {injuries.isLoading && injuries.data === undefined ? (
          <QueryStatePanel variant="loading" contextLabel="Injury events" height={96} />
        ) : injuries.error && injuries.data === undefined ? (
          <QueryStatePanel error={injuries.error} contextLabel="Injury events" height={96} />
        ) : injuries.data?.length ? (
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
