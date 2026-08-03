import { formatDateYmd } from "@dofek/format/format";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageLayout } from "../components/PageLayout.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { locallyReportedErrorMeta } from "../lib/query-client.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";

export type PersonalExperimentsSearch = {
  outcomeMetricId?: string;
  lagDays?: number;
};

type ExperimentView = {
  id: string;
  hypothesis: string;
  intervention: string;
  outcomeMetricId: string;
  outcomeMetricLabel: string;
  lagDays: number;
  baselineDays: number;
  interventionDays: number;
  startDate: string;
  status: "active" | "stopped";
  stoppedAt: string | null;
  phase: string;
  phaseLabel: string;
  schedule: {
    baselineStartDate: string;
    baselineEndDate: string;
    interventionStartDate: string;
    interventionEndDate: string;
    scheduleSummary: string;
  };
};

const adherenceValues = ["adherent", "partial", "not_adherent", "unknown"] as const;

type Adherence = (typeof adherenceValues)[number];

function isAdherence(value: string): value is Adherence {
  return adherenceValues.some((adherence) => adherence === value);
}

export function PersonalExperimentsPage({ search = {} }: { search?: PersonalExperimentsSearch }) {
  const listQuery = trpc.personalExperiments.list.useQuery();
  const metricsQuery = trpc.personalExperiments.metrics.useQuery();
  const utils = trpc.useUtils();

  const [hypothesis, setHypothesis] = useState("");
  const [intervention, setIntervention] = useState("");
  const [outcomeMetricId, setOutcomeMetricId] = useState(search.outcomeMetricId ?? "hrv");
  const [lagDays, setLagDays] = useState(search.lagDays ?? 0);
  const [baselineDays, setBaselineDays] = useState(7);
  const [interventionDays, setInterventionDays] = useState(14);
  const [startDate, setStartDate] = useState(formatDateYmd());

  const createMutation = trpc.personalExperiments.create.useMutation({
    meta: locallyReportedErrorMeta,
    onSuccess: async () => {
      setHypothesis("");
      setIntervention("");
      await utils.personalExperiments.list.invalidate();
    },
    onError: (error) => {
      captureException(error, { context: "personal-experiments-create" });
    },
  });

  const stopMutation = trpc.personalExperiments.stop.useMutation({
    meta: locallyReportedErrorMeta,
    onSuccess: async () => {
      await utils.personalExperiments.list.invalidate();
    },
    onError: (error) => {
      captureException(error, { context: "personal-experiments-stop" });
    },
  });

  const experiments = listQuery.data;
  const metrics = metricsQuery.data;

  return (
    <PageLayout
      title="Personal Experiments"
      subtitle="Set up an N-of-1 experiment with a baseline and intervention schedule. Correlation does not prove an intervention works."
    >
      <div className="space-y-6">
        <section className="card p-6 space-y-4">
          <h2 className="text-sm font-medium text-muted uppercase tracking-wider">
            Start an experiment
          </h2>
          {search.outcomeMetricId ? (
            <p className="text-sm text-dim">
              Outcome and lag were prefilled from Correlation Explorer. Choose an intervention you
              can control — a correlated metric is not automatically an intervention.
            </p>
          ) : null}

          {metricsQuery.isError && metrics === undefined ? (
            <QueryStatePanel error={metricsQuery.error} height={72} />
          ) : metricsQuery.isLoading || metrics === undefined ? (
            <QueryStatePanel variant="loading" height={72} />
          ) : (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                createMutation.mutate({
                  hypothesis,
                  intervention,
                  outcomeMetricId,
                  lagDays,
                  baselineDays,
                  interventionDays,
                  startDate,
                });
              }}
            >
              <label className="block">
                <span className="block text-[10px] text-subtle uppercase tracking-wider mb-1">
                  Hypothesis
                </span>
                <input
                  aria-label="Hypothesis"
                  value={hypothesis}
                  onChange={(event) => setHypothesis(event.target.value)}
                  required
                  className="w-full bg-surface border border-border rounded px-3 py-2 text-sm text-foreground"
                  placeholder="Does a consistent bedtime improve heart rate variability?"
                />
              </label>

              <label className="block">
                <span className="block text-[10px] text-subtle uppercase tracking-wider mb-1">
                  Intervention
                </span>
                <input
                  aria-label="Intervention"
                  value={intervention}
                  onChange={(event) => setIntervention(event.target.value)}
                  required
                  className="w-full bg-surface border border-border rounded px-3 py-2 text-sm text-foreground"
                  placeholder="Lights out by 10pm on weeknights"
                />
              </label>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="block">
                  <span className="block text-[10px] text-subtle uppercase tracking-wider mb-1">
                    Outcome metric
                  </span>
                  <select
                    aria-label="Outcome metric"
                    value={outcomeMetricId}
                    onChange={(event) => setOutcomeMetricId(event.target.value)}
                    className="w-full bg-surface border border-border rounded px-3 py-2 text-sm text-foreground"
                  >
                    {metrics.map((metric) => (
                      <option key={metric.id} value={metric.id}>
                        {metric.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="block text-[10px] text-subtle uppercase tracking-wider mb-1">
                    Outcome lag
                  </span>
                  <select
                    aria-label="Outcome lag"
                    value={lagDays}
                    onChange={(event) => setLagDays(Number(event.target.value))}
                    className="w-full bg-surface border border-border rounded px-3 py-2 text-sm text-foreground"
                  >
                    <option value={0}>Same day</option>
                    <option value={1}>+1 day</option>
                    <option value={2}>+2 days</option>
                    <option value={3}>+3 days</option>
                  </select>
                </label>

                <label className="block">
                  <span className="block text-[10px] text-subtle uppercase tracking-wider mb-1">
                    Baseline days
                  </span>
                  <input
                    aria-label="Baseline days"
                    type="number"
                    min={1}
                    max={90}
                    value={baselineDays}
                    onChange={(event) => setBaselineDays(Number(event.target.value))}
                    className="w-full bg-surface border border-border rounded px-3 py-2 text-sm text-foreground"
                  />
                </label>

                <label className="block">
                  <span className="block text-[10px] text-subtle uppercase tracking-wider mb-1">
                    Intervention days
                  </span>
                  <input
                    aria-label="Intervention days"
                    type="number"
                    min={1}
                    max={90}
                    value={interventionDays}
                    onChange={(event) => setInterventionDays(Number(event.target.value))}
                    className="w-full bg-surface border border-border rounded px-3 py-2 text-sm text-foreground"
                  />
                </label>

                <label className="block">
                  <span className="block text-[10px] text-subtle uppercase tracking-wider mb-1">
                    Start date
                  </span>
                  <input
                    aria-label="Start date"
                    type="date"
                    value={startDate}
                    onChange={(event) => setStartDate(event.target.value)}
                    className="w-full bg-surface border border-border rounded px-3 py-2 text-sm text-foreground"
                  />
                </label>
              </div>

              <button
                type="submit"
                disabled={createMutation.isPending}
                className="px-4 py-2 bg-accent text-on-accent rounded text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
              >
                {createMutation.isPending
                  ? "Saving..."
                  : createMutation.error
                    ? "Retry"
                    : "Start experiment"}
              </button>

              {createMutation.error ? (
                <QueryStatePanel error={createMutation.error} height={72} />
              ) : null}
            </form>
          )}
        </section>

        <section className="card p-6 space-y-4">
          <h2 className="text-sm font-medium text-muted uppercase tracking-wider">
            Your experiments
          </h2>

          {metricsQuery.isError && metrics !== undefined ? (
            <QueryStatePanel error={metricsQuery.error} height={72} />
          ) : null}

          {listQuery.isError && experiments === undefined ? (
            <QueryStatePanel error={listQuery.error} height={96} />
          ) : listQuery.isLoading || experiments === undefined ? (
            <QueryStatePanel variant="loading" height={96} />
          ) : experiments.length === 0 ? (
            <QueryStatePanel
              variant="empty"
              message="No experiments yet. Start one above, or open Correlation Explorer and choose Start experiment."
              height={96}
            />
          ) : (
            <div className="space-y-4">
              {listQuery.isError ? <QueryStatePanel error={listQuery.error} height={72} /> : null}
              {experiments.map((experiment) => (
                <ExperimentCard
                  key={experiment.id}
                  experiment={experiment}
                  onStop={() => stopMutation.mutate({ id: experiment.id })}
                  stopping={stopMutation.isPending && stopMutation.variables?.id === experiment.id}
                  outcomeUnit={
                    metrics?.find((metric) => metric.id === experiment.outcomeMetricId)?.unit
                  }
                  stopError={
                    stopMutation.variables?.id === experiment.id ? stopMutation.error : null
                  }
                />
              ))}
            </div>
          )}
        </section>

        <p className="text-xs text-dim">
          Looking for a hypothesis idea?{" "}
          <Link to="/correlation" className="text-foreground underline underline-offset-2">
            Open Correlation Explorer
          </Link>
          .
        </p>
      </div>
    </PageLayout>
  );
}

function ExperimentCard({
  experiment,
  onStop,
  stopping,
  outcomeUnit,
  stopError,
}: {
  experiment: ExperimentView;
  onStop: () => void;
  stopping: boolean;
  outcomeUnit: string | undefined;
  stopError: { message: string } | null;
}) {
  return (
    <article className="rounded-lg border border-border p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{experiment.hypothesis}</h3>
          <p className="text-xs text-dim mt-1">Intervention: {experiment.intervention}</p>
        </div>
        <span className="text-[10px] px-2 py-0.5 rounded-full border border-border-strong text-muted whitespace-nowrap">
          {experiment.phaseLabel}
        </span>
      </div>

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-dim">
        <div>
          <dt className="uppercase tracking-wider text-subtle">Outcome</dt>
          <dd className="text-foreground">
            {experiment.outcomeMetricLabel}
            {experiment.lagDays > 0 ? ` (+${experiment.lagDays} day lag)` : ""}
          </dd>
        </div>
        <div>
          <dt className="uppercase tracking-wider text-subtle">Schedule</dt>
          <dd className="text-foreground">{experiment.schedule.scheduleSummary}</dd>
        </div>
        <div>
          <dt className="uppercase tracking-wider text-subtle">Baseline</dt>
          <dd className="text-foreground">
            {experiment.schedule.baselineStartDate} → {experiment.schedule.baselineEndDate}
          </dd>
        </div>
        <div>
          <dt className="uppercase tracking-wider text-subtle">Intervention window</dt>
          <dd className="text-foreground">
            {experiment.schedule.interventionStartDate} → {experiment.schedule.interventionEndDate}
          </dd>
        </div>
      </dl>

      <ExperimentLearningCard experiment={experiment} outcomeUnit={outcomeUnit} />

      {experiment.status === "active" ? (
        <button
          type="button"
          onClick={onStop}
          disabled={stopping}
          className="px-3 py-1.5 text-xs rounded border border-border-strong text-muted hover:text-foreground disabled:opacity-50"
        >
          {stopping ? "Stopping..." : stopError ? "Retry stop" : "Stop experiment"}
        </button>
      ) : (
        <p className="text-xs text-dim">Stopped on {experiment.stoppedAt}</p>
      )}

      {stopError ? <QueryStatePanel error={stopError} height={64} /> : null}
    </article>
  );
}

function ExperimentLearningCard({
  experiment,
  outcomeUnit,
}: {
  experiment: ExperimentView;
  outcomeUnit: string | undefined;
}) {
  const analysisQuery = trpc.personalExperiments.analysis.useQuery({ id: experiment.id });
  const utils = trpc.useUtils();
  const [adherence, setAdherence] = useState<Adherence>("adherent");
  const [confounder, setConfounder] = useState("");
  const [note, setNote] = useState("");
  const [annotationLabel, setAnnotationLabel] = useState("");
  const [annotationNotes, setAnnotationNotes] = useState("");
  const today = formatDateYmd();
  const checkInMutation = trpc.personalExperiments.checkIn.useMutation({
    meta: locallyReportedErrorMeta,
    onSuccess: async () => {
      await Promise.all([
        utils.personalExperiments.analysis.invalidate({ id: experiment.id }),
        utils.personalExperiments.list.invalidate(),
      ]);
    },
    onError: (error) => captureException(error, { context: "personal-experiments-check-in" }),
  });
  const annotationMutation = trpc.lifeEvents.create.useMutation({
    meta: locallyReportedErrorMeta,
    onSuccess: async () => {
      setAnnotationLabel("");
      setAnnotationNotes("");
      await Promise.all([
        utils.personalExperiments.analysis.invalidate({ id: experiment.id }),
        utils.lifeEvents.list.invalidate(),
      ]);
    },
    onError: (error) => captureException(error, { context: "personal-experiments-annotation" }),
  });
  const result = analysisQuery.data;

  return (
    <section className="space-y-3 border-t border-border pt-3">
      <h4 className="text-xs font-medium uppercase tracking-wider text-muted">Outcome evidence</h4>
      {analysisQuery.isError && result === undefined ? (
        <QueryStatePanel error={analysisQuery.error} height={72} />
      ) : null}
      {!analysisQuery.isError && (analysisQuery.isLoading || result === undefined) ? (
        <QueryStatePanel variant="loading" height={72} />
      ) : null}
      {result !== undefined ? (
        <>
          <div className="rounded border border-border bg-surface-solid p-3 space-y-2">
            <label className="block text-xs text-subtle" htmlFor={`adherence-${experiment.id}`}>
              Adherence
            </label>
            <select
              id={`adherence-${experiment.id}`}
              aria-label="Adherence"
              value={adherence}
              onChange={(event) => {
                if (isAdherence(event.target.value)) setAdherence(event.target.value);
              }}
              className="w-full rounded border border-border bg-surface px-2 py-1 text-sm text-foreground"
            >
              <option value="adherent">Adherent</option>
              <option value="partial">Partial</option>
              <option value="not_adherent">Not adherent</option>
              <option value="unknown">Unknown</option>
            </select>
            <input
              aria-label="Confounder"
              value={confounder}
              onChange={(event) => setConfounder(event.target.value)}
              placeholder="Confounder (optional)"
              className="w-full rounded border border-border bg-surface px-2 py-1 text-sm text-foreground"
            />
            <input
              aria-label="Check-in note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Note (optional)"
              className="w-full rounded border border-border bg-surface px-2 py-1 text-sm text-foreground"
            />
            <button
              type="button"
              disabled={checkInMutation.isPending}
              onClick={() =>
                checkInMutation.mutate({
                  id: experiment.id,
                  date: today,
                  adherence,
                  confounder: confounder.trim() || null,
                  note: note.trim() || null,
                })
              }
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent disabled:opacity-50"
            >
              {checkInMutation.isPending ? "Saving..." : "Record today's check-in"}
            </button>
            {checkInMutation.error ? (
              <QueryStatePanel error={checkInMutation.error} height={72} />
            ) : null}
          </div>
          <p className="text-xs text-dim">
            {result.analysis.coverage.baseline.observedOutcomeDayCount} of{" "}
            {result.analysis.coverage.baseline.expectedDayCount} baseline outcomes observed ·{" "}
            {result.analysis.coverage.intervention.observedOutcomeDayCount} of{" "}
            {result.analysis.coverage.intervention.expectedDayCount} intervention outcomes observed
          </p>
          {result.analysis.availability === "available" ? (
            <p className="text-sm text-foreground">
              Observed difference: {result.analysis.effect.differenceInMeans.toFixed(1)}
              {outcomeUnit ? ` ${outcomeUnit}` : ""} ({result.analysis.effect.baselineSampleCount}{" "}
              baseline, {result.analysis.effect.interventionSampleCount} intervention outcomes)
            </p>
          ) : (
            <p className="text-sm text-muted">
              More outcome observations are needed before estimating an effect.
            </p>
          )}
          {result.analysis.uncertainty.availability === "available" ? (
            <p className="text-xs text-dim">
              95% circular moving-block interval: {result.analysis.uncertainty.lower.toFixed(1)} to{" "}
              {result.analysis.uncertainty.upper.toFixed(1)}
              {outcomeUnit ? ` ${outcomeUnit}` : ""}
            </p>
          ) : (
            <p className="text-xs text-dim">
              Uncertainty unavailable: {result.analysis.uncertainty.reason.replaceAll("_", " ")}.
            </p>
          )}
          <ul className="list-disc space-y-1 pl-4 text-xs text-dim">
            {result.analysis.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
          <details className="text-xs text-dim">
            <summary>Outcome observations</summary>
            <ul className="mt-2 space-y-1">
              {result.analysis.observations.map((observation) => (
                <li key={`${observation.phase}-${observation.phaseDate}`}>
                  {observation.phaseDate} → {observation.outcomeDate}:{" "}
                  {observation.value ?? "Missing"};{" "}
                  {observation.phase === "baseline"
                    ? "baseline"
                    : (observation.adherence ?? "no check-in")}
                  ; sources: {observation.sourceProviderIds.join(", ") || "none reported"}
                </li>
              ))}
            </ul>
          </details>
          <div className="space-y-2 rounded border border-border p-3">
            <h5 className="text-xs font-medium text-muted">Experiment annotations</h5>
            {result.annotations.map((annotation) => (
              <p key={annotation.id} className="text-xs text-dim">
                <span className="text-foreground">{annotation.label}</span> · {annotation.startedAt}
                {annotation.notes ? ` · ${annotation.notes}` : ""}
              </p>
            ))}
            <input
              aria-label="Annotation label"
              value={annotationLabel}
              onChange={(event) => setAnnotationLabel(event.target.value)}
              placeholder="Add a life event"
              className="w-full rounded border border-border bg-surface px-2 py-1 text-sm text-foreground"
            />
            <input
              aria-label="Annotation note"
              value={annotationNotes}
              onChange={(event) => setAnnotationNotes(event.target.value)}
              placeholder="Notes (optional)"
              className="w-full rounded border border-border bg-surface px-2 py-1 text-sm text-foreground"
            />
            <button
              type="button"
              disabled={!annotationLabel.trim() || annotationMutation.isPending}
              onClick={() =>
                annotationMutation.mutate({
                  label: annotationLabel.trim(),
                  startedAt: today,
                  endedAt: null,
                  category: null,
                  ongoing: false,
                  notes: annotationNotes.trim() || null,
                  personalExperimentId: experiment.id,
                })
              }
              className="rounded border border-border px-3 py-1.5 text-xs text-foreground disabled:opacity-50"
            >
              Save annotation
            </button>
            {annotationMutation.error ? (
              <QueryStatePanel error={annotationMutation.error} height={72} />
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
