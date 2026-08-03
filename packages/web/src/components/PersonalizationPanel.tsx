import {
  formatDateMedium,
  formatDurationMinutes,
  formatIntensity,
  formatStandardDeviation,
} from "@dofek/format/format";
import type { PersonalizationModelCard } from "dofek-server/types";
import { useEffect } from "react";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";

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
    return <p className="text-sm text-red-400">{status.error.message}</p>;
  }

  const data = status.data;
  if (!data) return null;
  const resolvedModelCards = resolveModelCards(data.modelCards);
  if ("missingKey" in resolvedModelCards) {
    return <IncompleteModelCardsError missingKey={resolvedModelCards.missingKey} />;
  }
  const modelCards = resolvedModelCards.cards;

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
            Last refit attempt {formatDateMedium(data.fittedAt)}
          </span>
        )}
      </div>

      {/* Parameter cards */}
      <div className="space-y-3">
        <ParamCard
          modelCard={modelCards.exponentialMovingAverage}
          effective={data.effective.exponentialMovingAverage}
          defaults={data.defaults.exponentialMovingAverage}
          renderValue={(v: { chronicTrainingLoadDays: number; acuteTrainingLoadDays: number }) =>
            `Fitness: ${v.chronicTrainingLoadDays} days, Fatigue: ${v.acuteTrainingLoadDays} days`
          }
        />

        <ParamCard
          modelCard={modelCards.readinessWeights}
          effective={data.effective.readinessWeights}
          defaults={data.defaults.readinessWeights}
          renderValue={(v: {
            hrv: number;
            restingHr: number;
            sleep: number;
            respiratoryRate: number;
          }) =>
            `Heart Rate Variability ${formatIntensity(v.hrv * 100)}, Resting Heart Rate ${formatIntensity(v.restingHr * 100)}, Sleep ${formatIntensity(v.sleep * 100)}, Respiratory Rate ${formatIntensity(v.respiratoryRate * 100)}`
          }
        />

        <ParamCard
          modelCard={modelCards.sleepTarget}
          effective={data.effective.sleepTarget}
          defaults={data.defaults.sleepTarget}
          renderValue={(v: { minutes: number }) => formatDurationMinutes(v.minutes)}
        />

        <ParamCard
          modelCard={modelCards.stressThresholds}
          effective={data.effective.stressThresholds}
          defaults={data.defaults.stressThresholds}
          renderValue={(v: {
            hrvThresholds: [number, number, number];
            rhrThresholds: [number, number, number];
          }) =>
            `Heart Rate Variability: ${v.hrvThresholds.map(formatStandardDeviation).join(", ")} · Resting Heart Rate: ${v.rhrThresholds.map(formatStandardDeviation).join(", ")}`
          }
        />

        <ParamCard
          modelCard={modelCards.trainingImpulseConstants}
          effective={data.effective.trainingImpulseConstants}
          defaults={data.defaults.trainingImpulseConstants}
          renderValue={(v: { genderFactor: number; exponent: number }) =>
            `Factor: ${v.genderFactor}, Exponent: ${v.exponent}`
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
  modelCard,
  effective,
  defaults,
  renderValue,
}: {
  modelCard: PersonalizationModelCard;
  effective: T;
  defaults: T;
  renderValue: (v: T) => string;
}) {
  const isPersonalized = modelCard.status === "personalized";
  const lastFit = modelCard.lastSuccessfulFitAt
    ? formatDateMedium(modelCard.lastSuccessfulFitAt)
    : modelCard.lastFitSummary;

  return (
    <article
      aria-label={`${modelCard.title} model evidence`}
      className="rounded-md bg-accent/10 px-3 py-2.5 space-y-1"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">{modelCard.title}</span>
        <span
          className={`text-[10px] font-medium uppercase tracking-wider ${isPersonalized ? "text-accent" : "text-dim"}`}
        >
          {isPersonalized ? "Learned" : "Default"}
        </span>
      </div>
      <p className="text-xs text-subtle">{modelCard.description}</p>
      <p className="text-sm text-foreground font-mono">{renderValue(effective)}</p>
      {isPersonalized && <p className="text-[11px] text-dim">Default: {renderValue(defaults)}</p>}
      <dl className="pt-2 space-y-1 text-[11px] text-subtle">
        <EvidenceRow label="Last successful fit" value={lastFit} />
        <EvidenceRow label="Data window" value={modelCard.dataWindow} />
        <EvidenceRow label="Data sufficiency" value={modelCard.dataSufficiency} />
        <EvidenceRow label="Fit evidence" value={modelCard.fitEvidence} />
        <EvidenceRow label="Uncertainty" value={modelCard.uncertainty} />
      </dl>
      <div className="pt-1 text-[11px] text-subtle">
        <p className="font-medium">Excluded data</p>
        <ul className="list-disc pl-4">
          {modelCard.excludedData.map((exclusion) => (
            <li key={exclusion}>{exclusion}</li>
          ))}
        </ul>
      </div>
    </article>
  );
}

function EvidenceRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="inline font-medium">{label}: </dt>
      <dd className="inline">{value}</dd>
    </div>
  );
}

type ModelCardsByKey = Record<PersonalizationModelCard["key"], PersonalizationModelCard>;

function resolveModelCards(
  modelCards: PersonalizationModelCard[],
): { cards: ModelCardsByKey } | { missingKey: PersonalizationModelCard["key"] } {
  const exponentialMovingAverage = modelCards.find(
    (card) => card.key === "exponentialMovingAverage",
  );
  if (!exponentialMovingAverage) return { missingKey: "exponentialMovingAverage" };
  const readinessWeights = modelCards.find((card) => card.key === "readinessWeights");
  if (!readinessWeights) return { missingKey: "readinessWeights" };
  const sleepTarget = modelCards.find((card) => card.key === "sleepTarget");
  if (!sleepTarget) return { missingKey: "sleepTarget" };
  const stressThresholds = modelCards.find((card) => card.key === "stressThresholds");
  if (!stressThresholds) return { missingKey: "stressThresholds" };
  const trainingImpulseConstants = modelCards.find(
    (card) => card.key === "trainingImpulseConstants",
  );
  if (!trainingImpulseConstants) return { missingKey: "trainingImpulseConstants" };

  return {
    cards: {
      exponentialMovingAverage,
      readinessWeights,
      sleepTarget,
      stressThresholds,
      trainingImpulseConstants,
    },
  };
}

function IncompleteModelCardsError({
  missingKey,
}: {
  missingKey: PersonalizationModelCard["key"];
}) {
  useEffect(() => {
    captureException(new Error(`Missing personalization model card: ${missingKey}`), {
      context: "personalization-model-cards",
      missingModelCard: missingKey,
    });
  }, [missingKey]);

  return (
    <p className="text-sm text-red-400">
      Personalization model details are incomplete. Refresh and try again; contact support if this
      continues.
    </p>
  );
}
