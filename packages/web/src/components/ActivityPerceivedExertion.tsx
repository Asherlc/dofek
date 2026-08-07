import { useEffect, useState } from "react";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";

export function ActivityPerceivedExertion({
  activityId,
  value,
}: {
  activityId: string;
  value: number | null;
}) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState<number | null>(value);
  const mutation = trpc.activity.setPerceivedExertion.useMutation({
    onSuccess: (result) => {
      setDraft(result.perceivedExertion);
      void utils.activity.byId.invalidate({ id: activityId });
    },
    onError: (error) => captureException(error, { operation: "activity.setPerceivedExertion" }),
  });

  useEffect(() => setDraft(value), [value]);

  return (
    <section className="card p-4 space-y-3" aria-labelledby="activity-rpe-heading">
      <div>
        <h2 id="activity-rpe-heading" className="font-medium">
          Session effort
        </h2>
        <p className="text-xs text-muted">Your perceived exertion for this session (0–10).</p>
      </div>
      <div className="flex items-center gap-3">
        <input
          aria-label="Session perceived exertion"
          type="range"
          min={0}
          max={10}
          step={1}
          value={draft ?? 0}
          onChange={(event) => setDraft(Number(event.target.value))}
          className="flex-1"
        />
        <span className="w-8 text-center font-medium">{draft == null ? "—" : draft}</span>
        <button
          type="button"
          className="rounded bg-accent/15 px-2 py-1 text-xs text-accent"
          onClick={() => mutation.mutate({ id: activityId, value: draft ?? 0 })}
          disabled={mutation.isPending || draft == null}
        >
          Save
        </button>
        <button
          type="button"
          className="rounded border border-border px-2 py-1 text-xs"
          onClick={() => mutation.mutate({ id: activityId, value: null })}
          disabled={mutation.isPending}
        >
          Clear
        </button>
      </div>
      {mutation.error && <p className="text-sm text-red-400">{mutation.error.message}</p>}
    </section>
  );
}
