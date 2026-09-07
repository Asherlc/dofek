import { formatDateYmd } from "@dofek/format/format";
import { useState } from "react";
import { trpc } from "../lib/trpc.ts";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

export function SubjectiveTrackingPanel() {
  const [bodyRegionId, setBodyRegionId] = useState("");
  const [description, setDescription] = useState("");
  const utils = trpc.useUtils();
  const injuries = trpc.subjective.injuries.useQuery();
  const regions = trpc.subjective.regions.useQuery();
  const createInjury = trpc.subjective.createInjury.useMutation({
    onSuccess: async () => {
      setBodyRegionId("");
      setDescription("");
      await utils.subjective.injuries.invalidate();
    },
  });
  const saveCheckIn = trpc.subjective.saveCheckIn.useMutation();

  return (
    <div className="card p-4 space-y-3">
      <h3 className="font-medium">Injury and niggle timeline</h3>
      <button
        className="rounded border px-2 py-1 text-sm disabled:opacity-50"
        disabled={saveCheckIn.isPending}
        onClick={() =>
          saveCheckIn.mutate({
            date: formatDateYmd(),
            symptoms: [],
          })
        }
        type="button"
      >
        All clear today
      </button>
      {saveCheckIn.error ? (
        <p className="text-sm text-red-600">{saveCheckIn.error.message}</p>
      ) : null}
      {regions.isLoading && regions.data === undefined ? (
        <QueryStatePanel variant="loading" contextLabel="Body regions" height={72} />
      ) : regions.error && regions.data === undefined ? (
        <QueryStatePanel error={regions.error} contextLabel="Body regions" height={72} />
      ) : regions.data?.length ? (
        <form
          className="grid gap-2 sm:grid-cols-[minmax(10rem,0.7fr)_minmax(14rem,1.3fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            const note = description.trim();
            if (!bodyRegionId || !note) return;
            createInjury.mutate({
              bodyRegionId,
              description: note,
              kind: "niggle",
              onsetDate: formatDateYmd(),
              resolvedDate: null,
              severity: null,
            });
          }}
        >
          <select
            aria-label="Body region"
            className="rounded border px-2 py-1 text-sm"
            onChange={(event) => setBodyRegionId(event.target.value)}
            value={bodyRegionId}
          >
            <option value="">Body region</option>
            {regions.data?.map((region) => (
              <option key={region.id} value={region.id}>
                {region.label}
              </option>
            ))}
          </select>
          <input
            aria-label="Injury note"
            className="rounded border px-2 py-1 text-sm"
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What hurts or feels unusual?"
            value={description}
          />
          <button
            className="rounded border px-2 py-1 text-sm disabled:opacity-50"
            disabled={createInjury.isPending || !bodyRegionId || !description.trim()}
            type="submit"
          >
            Log injury note
          </button>
        </form>
      ) : (
        <p className="text-sm text-dim">No body regions are available.</p>
      )}
      {regions.error && regions.data !== undefined ? (
        <p className="text-sm text-red-600">{regions.error.message}</p>
      ) : null}
      {createInjury.error ? (
        <p className="text-sm text-red-600">{createInjury.error.message}</p>
      ) : null}
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
