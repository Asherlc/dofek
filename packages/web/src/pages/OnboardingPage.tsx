import {
  GET_STARTED_GOALS,
  GET_STARTED_STEPS,
  type GetStartedGoalId,
} from "@dofek/onboarding/get-started-flow";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageLayout } from "../components/PageLayout.tsx";

export function OnboardingPage() {
  const [selectedGoalId, setSelectedGoalId] = useState<GetStartedGoalId>(GET_STARTED_GOALS[0].id);
  const selectedGoal = GET_STARTED_GOALS.find((goal) => goal.id === selectedGoalId);

  return (
    <PageLayout headerChildren={undefined}>
      <section className="card p-5 sm:p-8">
        <div className="grid gap-8 lg:grid-cols-[0.85fr_1.15fr]">
          <div>
            <p className="text-sm font-semibold text-accent">Get started</p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
              Set up Dofek
            </h1>
            <p className="mt-4 max-w-xl text-sm leading-6 text-muted sm:text-base">
              Choose the first question you want to answer, connect the sources that matter, then
              open the dashboard when the first useful signal is ready.
            </p>
            {selectedGoal && (
              <p className="mt-4 rounded-lg border border-border bg-surface-solid px-4 py-3 text-sm font-medium text-foreground">
                Selected: {selectedGoal.title}
              </p>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {GET_STARTED_GOALS.map((goal) => {
              const selected = goal.id === selectedGoalId;
              return (
                <button
                  key={goal.id}
                  type="button"
                  onClick={() => setSelectedGoalId(goal.id)}
                  className={`rounded-lg border p-4 text-left transition-colors ${
                    selected
                      ? "border-accent bg-accent/10 text-foreground"
                      : "border-border bg-white/70 text-foreground hover:border-border-strong"
                  }`}
                >
                  <span className="block text-sm font-semibold">{goal.title}</span>
                  <span className="mt-2 block text-sm leading-5 text-muted">
                    {goal.description}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section className="mt-4 grid gap-3 lg:grid-cols-4">
        {GET_STARTED_STEPS.map((step, stepIndex) => (
          <div key={step.id} className="rounded-lg border border-border bg-white/70 p-5">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-muted">
              Step {stepIndex + 1}
            </p>
            <h2 className="mt-3 text-base font-semibold text-foreground">{step.title}</h2>
            <p className="mt-2 min-h-16 text-sm leading-5 text-muted">{step.description}</p>
            <Link
              to={step.webPath}
              className="mt-4 inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
            >
              {step.actionLabel}
            </Link>
          </div>
        ))}
      </section>
    </PageLayout>
  );
}
