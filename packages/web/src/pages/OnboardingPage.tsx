import { GET_STARTED_STEPS, IOS_TESTFLIGHT_INVITE } from "@dofek/onboarding/get-started-flow";
import { Link } from "@tanstack/react-router";
import { PageLayout } from "../components/PageLayout.tsx";
import { PrimaryGoalSelector } from "../components/PrimaryGoalSelector.tsx";

export function OnboardingPage() {
  return (
    <PageLayout headerChildren={undefined}>
      <section className="rounded-lg border border-border bg-surface-solid p-5 sm:p-8">
        <p className="text-sm font-semibold text-accent">First-run setup</p>
        <h1 className="mt-2 max-w-3xl text-3xl font-bold text-foreground sm:text-4xl">
          Set up Dofek with your real data
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-6 text-muted sm:text-base">
          Dofek is useful after it has data to work with. Start by choosing a primary goal,
          connecting the sources you already use, then open the dashboard when sync has something to
          show.
        </p>
      </section>

      <section className="mt-4 rounded-lg border border-border bg-surface p-5 shadow-sm sm:p-6">
        <PrimaryGoalSelector />
      </section>

      <section className="mt-4 grid gap-4 lg:grid-cols-3">
        {GET_STARTED_STEPS.map((step, stepIndex) => (
          <div
            key={step.id}
            className="flex min-h-56 flex-col rounded-lg border border-border bg-surface p-5 shadow-sm sm:p-6"
          >
            <div className="mb-5 flex h-9 w-9 items-center justify-center rounded-md bg-accent/10 text-sm font-bold text-accent">
              {stepIndex + 1}
            </div>
            <h2 className="text-xl font-semibold text-foreground">{step.title}</h2>
            <p className="mt-3 text-sm leading-6 text-muted">{step.description}</p>
            <Link
              to={step.webPath}
              className="mt-auto inline-flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent/90"
            >
              {step.actionLabel}
            </Link>
          </div>
        ))}
        <div className="flex min-h-56 flex-col rounded-lg border border-border bg-surface p-5 shadow-sm sm:p-6">
          <div className="mb-5 flex h-9 w-9 items-center justify-center rounded-md bg-accent/10 text-sm font-bold text-accent">
            {GET_STARTED_STEPS.length + 1}
          </div>
          <h2 className="text-xl font-semibold text-foreground">{IOS_TESTFLIGHT_INVITE.title}</h2>
          <p className="mt-3 text-sm leading-6 text-muted">{IOS_TESTFLIGHT_INVITE.description}</p>
          <a
            href={IOS_TESTFLIGHT_INVITE.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-auto inline-flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent/90"
          >
            {IOS_TESTFLIGHT_INVITE.actionLabel}
          </a>
        </div>
      </section>
    </PageLayout>
  );
}
