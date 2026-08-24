import { useState } from "react";
import { useTodayQueryDate } from "../hooks/useTodayQueryDate.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

type InjuryKind = "injury" | "niggle";

function isInjuryKind(value: string): value is InjuryKind {
  return value === "injury" || value === "niggle";
}

export function SubjectiveTrackingPanel() {
  const date = useTodayQueryDate();
  const utils = trpc.useUtils();
  const regions = trpc.subjective.regions.useQuery();
  const injuries = trpc.subjective.injuries.useQuery();
  const [selectedInjuryRegion, setSelectedInjuryRegion] = useState("");
  const [selectedInjuryKind, setSelectedInjuryKind] = useState<InjuryKind>("niggle");
  const [selectedInjurySeverity, setSelectedInjurySeverity] = useState(0);
  const [injuryOnsetDate, setInjuryOnsetDate] = useState(date);
  const [injuryResolvedDate, setInjuryResolvedDate] = useState<string | null>(null);
  const [injuryDescription, setInjuryDescription] = useState("");
  const createInjury = trpc.subjective.createInjury.useMutation({
    onSuccess: () => {
      setInjuryDescription("");
      setInjuryOnsetDate(date);
      setInjuryResolvedDate(null);
      void utils.subjective.injuries.invalidate();
      void utils.subjective.timeline.invalidate();
    },
    onError: (error) => captureException(error, { operation: "subjective.createInjury" }),
  });

  const injuryReady =
    selectedInjuryRegion !== "" && injuryOnsetDate.trim() !== "" && injuryDescription.trim() !== "";

  return (
    <div className="card p-4 space-y-3">
      <h3 className="font-medium">Injury and niggle timeline</h3>
      {regions.isLoading && regions.data === undefined ? (
        <QueryStatePanel variant="loading" contextLabel="Injury body regions" height={96} />
      ) : regions.error && regions.data === undefined ? (
        <QueryStatePanel error={regions.error} contextLabel="Injury body regions" height={96} />
      ) : regions.data?.length === 0 ? (
        <QueryStatePanel variant="empty" message="No body regions are available." height={96} />
      ) : (
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-xs text-muted">
            Injury body region
            <select
              aria-label="Injury body region"
              className="block mt-1 rounded border border-border bg-surface px-2 py-1 text-sm"
              value={selectedInjuryRegion}
              onChange={(event) => setSelectedInjuryRegion(event.target.value)}
            >
              <option value="">Choose region</option>
              {regions.data?.map((region) => (
                <option key={region.id} value={region.id}>
                  {region.label}
                </option>
              ))}
            </select>
          </label>
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
            disabled={!injuryReady || createInjury.isPending}
            onClick={() => {
              if (!injuryReady) return;
              createInjury.mutate({
                kind: selectedInjuryKind,
                bodyRegionId: selectedInjuryRegion,
                onsetDate: injuryOnsetDate,
                resolvedDate: injuryResolvedDate,
                severity: selectedInjurySeverity,
                description: injuryDescription.trim(),
              });
            }}
          >
            Add {selectedInjuryKind}
          </button>
        </div>
      )}
      {createInjury.error && <p className="text-sm text-red-400">{createInjury.error.message}</p>}
      {injuries.isLoading && injuries.data === undefined ? (
        <QueryStatePanel variant="loading" contextLabel="Injury events" height={96} />
      ) : injuries.error && injuries.data === undefined ? (
        <QueryStatePanel error={injuries.error} contextLabel="Injury events" height={96} />
      ) : injuries.data?.length ? (
        <ul className="space-y-1 text-sm">
          {injuries.data.map((injury) => (
            <li key={injury.id}>
              {injury.kind} · {injury.description} ·{" "}
              {injury.severity == null ? "Severity not recorded" : `${injury.severity}/10`} ·{" "}
              {injury.onset_date}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-dim">No injury events logged.</p>
      )}
    </div>
  );
}
