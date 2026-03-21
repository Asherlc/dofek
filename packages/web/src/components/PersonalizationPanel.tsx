import { trpc } from "../lib/trpc.ts";

const PARAM_LABELS: Record<string, { label: string; description: string }> = {
  exponentialMovingAverage: {
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
  trainingImpulseConstants: {
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
  const invalidateAll = () => {
    utils.personalization.status.invalidate();
    // Invalidate queries that depend on personalized params
    utils.pmc.invalidate();
    utils.recovery.invalidate();
    utils.stress.invalidate();
  };
  const refitMutation = trpc.personalization.refit.useMutation({ onSuccess: invalidateAll });
  const resetMutation = trpc.personalization.reset.useMutation({ onSuccess: invalidateAll });

  if (status.isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 rounded bg-skeleton animate-pulse" />
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
          <div className={`w-2 h-2 rounded-full ${data.isPersonalized ? "bg-accent" : "bg-dim"}`} />
          <span className="text-sm text-foreground">
            {data.isPersonalized ? "Personalized" : "Using defaults"}
          </span>
        </div>
        {data.fittedAt && (
          <span className="text-xs text-subtle">
            Last updated {new Date(data.fittedAt).toLocaleDateString()}
          </span>
        )}
      </div>

      {/* Parameter cards */}
      <div className="space-y-3">
        <ParamCard
          paramKey="exponentialMovingAverage"
          personalized={data.parameters.exponentialMovingAverage}
          effective={data.effective.exponentialMovingAverage}
          defaults={data.defaults.exponentialMovingAverage}
          renderValue={(v: { chronicTrainingLoadDays: number; acuteTrainingLoadDays: number }) =>
            `Fitness: ${v.chronicTrainingLoadDays} days, Fatigue: ${v.acuteTrainingLoadDays} days`
          }
          renderQuality={
            data.parameters.exponentialMovingAverage
              ? `${data.parameters.exponentialMovingAverage.sampleCount} days, r=${data.parameters.exponentialMovingAverage.correlation}`
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
            `Heart Rate Variability ${Math.round(v.hrv * 100)}%, Resting Heart Rate ${Math.round(v.restingHr * 100)}%, Sleep ${Math.round(v.sleep * 100)}%, Load ${Math.round(v.loadBalance * 100)}%`
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
            `Heart Rate Variability: ${v.hrvThresholds.map((t) => t.toFixed(1)).join(", ")} · Resting Heart Rate: ${v.rhrThresholds.map((t) => t.toFixed(1)).join(", ")}`
          }
          renderQuality={
            data.parameters.stressThresholds
              ? `${data.parameters.stressThresholds.sampleCount} days`
              : undefined
          }
        />

        <ParamCard
          paramKey="trainingImpulseConstants"
          personalized={data.parameters.trainingImpulseConstants}
          effective={data.effective.trainingImpulseConstants}
          defaults={data.defaults.trainingImpulseConstants}
          renderValue={(v: { genderFactor: number; exponent: number }) =>
            `Factor: ${v.genderFactor}, Exponent: ${v.exponent}`
          }
          renderQuality={
            data.parameters.trainingImpulseConstants
              ? `${data.parameters.trainingImpulseConstants.sampleCount} activities, R²=${data.parameters.trainingImpulseConstants.r2}`
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
          className="text-xs font-medium text-accent hover:text-accent-secondary border border-accent rounded px-3 py-1.5 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {refitMutation.isPending ? "Refitting..." : "Refit Now"}
        </button>
        {data.isPersonalized && (
          <button
            type="button"
            onClick={() => resetMutation.mutate()}
            disabled={resetMutation.isPending}
            className="text-xs text-muted hover:text-foreground border border-border-strong rounded px-3 py-1.5 transition-colors cursor-pointer disabled:opacity-50"
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
    <div className="rounded-md bg-accent/10 px-3 py-2.5 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">{meta?.label ?? paramKey}</span>
        <span
          className={`text-[10px] font-medium uppercase tracking-wider ${isPersonalized ? "text-accent" : "text-dim"}`}
        >
          {isPersonalized ? "Learned" : "Default"}
        </span>
      </div>
      <p className="text-xs text-subtle">{meta?.description}</p>
      <p className="text-sm text-foreground font-mono">{renderValue(effective)}</p>
      {isPersonalized && renderQuality && (
        <p className="text-[11px] text-subtle">Quality: {renderQuality}</p>
      )}
      {isPersonalized && <p className="text-[11px] text-dim">Default: {renderValue(defaults)}</p>}
    </div>
  );
}
