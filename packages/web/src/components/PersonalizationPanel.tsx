import { trpc } from "../lib/trpc.ts";

const PARAM_LABELS: Record<string, { label: string; description: string }> = {
  ewma: {
    label: "Training Load Windows",
    description: "How many days of training history are used to compute fitness and fatigue",
  },
  readinessWeights: {
    label: "Readiness Score Weights",
    description: "How much each factor contributes to your daily readiness score",
  },
  sleepTarget: {
    label: "Sleep Target",
    description: "The amount of sleep associated with your best recovery",
  },
  stressThresholds: {
    label: "Stress Sensitivity",
    description: "How your heart rate variability and resting heart rate map to stress levels",
  },
  trimpConstants: {
    label: "Heart Rate Effort Model",
    description: "How heart rate intensity translates to training load",
  },
};

function formatMinutes(min: number): string {
  const hours = Math.floor(min / 60);
  const mins = min % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

export function PersonalizationPanel() {
  const status = trpc.personalization.status.useQuery();
  const utils = trpc.useUtils();
  const refitMutation = trpc.personalization.refit.useMutation({
    onSuccess: () => utils.personalization.status.invalidate(),
  });
  const resetMutation = trpc.personalization.reset.useMutation({
    onSuccess: () => utils.personalization.status.invalidate(),
  });

  if (status.isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 rounded bg-zinc-800/50 animate-pulse" />
        ))}
      </div>
    );
  }

  if (status.error) {
    return <p className="text-sm text-red-400">Failed to load personalization status</p>;
  }

  const data = status.data;
  if (!data) return null;

  return (
    <div className="space-y-4">
      {/* Status header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${data.isPersonalized ? "bg-emerald-400" : "bg-zinc-600"}`}
          />
          <span className="text-sm text-zinc-300">
            {data.isPersonalized ? "Personalized" : "Using defaults"}
          </span>
        </div>
        {data.fittedAt && (
          <span className="text-xs text-zinc-500">
            Last updated {new Date(data.fittedAt).toLocaleDateString()}
          </span>
        )}
      </div>

      {/* Parameter cards */}
      <div className="space-y-3">
        <ParamCard
          paramKey="ewma"
          personalized={data.parameters.ewma}
          effective={data.effective.ewma}
          defaults={data.defaults.ewma}
          renderValue={(v: { ctlDays: number; atlDays: number }) =>
            `Fitness: ${v.ctlDays} days, Fatigue: ${v.atlDays} days`
          }
          renderQuality={
            data.parameters.ewma
              ? `${data.parameters.ewma.sampleCount} days, r=${data.parameters.ewma.correlation}`
              : undefined
          }
        />

        <ParamCard
          paramKey="readinessWeights"
          personalized={data.parameters.readinessWeights}
          effective={data.effective.readinessWeights}
          defaults={data.defaults.readinessWeights}
          renderValue={(v: {
            hrv: number;
            restingHr: number;
            sleep: number;
            loadBalance: number;
          }) =>
            `HRV ${Math.round(v.hrv * 100)}%, Resting HR ${Math.round(v.restingHr * 100)}%, Sleep ${Math.round(v.sleep * 100)}%, Load ${Math.round(v.loadBalance * 100)}%`
          }
          renderQuality={
            data.parameters.readinessWeights
              ? `${data.parameters.readinessWeights.sampleCount} days, r=${data.parameters.readinessWeights.correlation}`
              : undefined
          }
        />

        <ParamCard
          paramKey="sleepTarget"
          personalized={data.parameters.sleepTarget}
          effective={data.effective.sleepTarget}
          defaults={data.defaults.sleepTarget}
          renderValue={(v: { minutes: number }) => formatMinutes(v.minutes)}
          renderQuality={
            data.parameters.sleepTarget
              ? `${data.parameters.sleepTarget.sampleCount} qualifying nights`
              : undefined
          }
        />

        <ParamCard
          paramKey="stressThresholds"
          personalized={data.parameters.stressThresholds}
          effective={data.effective.stressThresholds}
          defaults={data.defaults.stressThresholds}
          renderValue={(v: {
            hrvThresholds: [number, number, number];
            rhrThresholds: [number, number, number];
          }) =>
            `HRV: ${v.hrvThresholds.map((t) => t.toFixed(1)).join(", ")} · RHR: ${v.rhrThresholds.map((t) => t.toFixed(1)).join(", ")}`
          }
          renderQuality={
            data.parameters.stressThresholds
              ? `${data.parameters.stressThresholds.sampleCount} days`
              : undefined
          }
        />

        <ParamCard
          paramKey="trimpConstants"
          personalized={data.parameters.trimpConstants}
          effective={data.effective.trimpConstants}
          defaults={data.defaults.trimpConstants}
          renderValue={(v: { genderFactor: number; exponent: number }) =>
            `Factor: ${v.genderFactor}, Exponent: ${v.exponent}`
          }
          renderQuality={
            data.parameters.trimpConstants
              ? `${data.parameters.trimpConstants.sampleCount} activities, R²=${data.parameters.trimpConstants.r2}`
              : undefined
          }
        />
      </div>

      {/* Actions */}
      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={() => refitMutation.mutate()}
          disabled={refitMutation.isPending}
          className="text-xs font-medium text-emerald-400 hover:text-emerald-300 border border-emerald-700 rounded px-3 py-1.5 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {refitMutation.isPending ? "Refitting..." : "Refit Now"}
        </button>
        {data.isPersonalized && (
          <button
            type="button"
            onClick={() => resetMutation.mutate()}
            disabled={resetMutation.isPending}
            className="text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded px-3 py-1.5 transition-colors cursor-pointer disabled:opacity-50"
          >
            Reset to Defaults
          </button>
        )}
      </div>
    </div>
  );
}

function ParamCard<T>({
  paramKey,
  personalized,
  effective,
  defaults,
  renderValue,
  renderQuality,
}: {
  paramKey: string;
  personalized: unknown;
  effective: T;
  defaults: T;
  renderValue: (v: T) => string;
  renderQuality?: string;
}) {
  const meta = PARAM_LABELS[paramKey];
  const isPersonalized = personalized !== null;

  return (
    <div className="rounded-md bg-zinc-800/50 px-3 py-2.5 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-zinc-200">{meta?.label ?? paramKey}</span>
        <span
          className={`text-[10px] font-medium uppercase tracking-wider ${isPersonalized ? "text-emerald-400" : "text-zinc-600"}`}
        >
          {isPersonalized ? "Learned" : "Default"}
        </span>
      </div>
      <p className="text-xs text-zinc-500">{meta?.description}</p>
      <p className="text-sm text-zinc-300 font-mono">{renderValue(effective)}</p>
      {isPersonalized && renderQuality && (
        <p className="text-[11px] text-zinc-500">Quality: {renderQuality}</p>
      )}
      {isPersonalized && (
        <p className="text-[11px] text-zinc-600">Default: {renderValue(defaults)}</p>
      )}
    </div>
  );
}
