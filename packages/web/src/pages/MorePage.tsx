import { Link } from "@tanstack/react-router";
import { PageLayout } from "../components/PageLayout.tsx";

const destinations = [
  {
    to: "/settings",
    title: "Account & settings",
    description: "Manage your profile, preferences, data sources, and account.",
  },
  {
    to: "/breathwork",
    title: "Breathwork",
    description: "Start a guided breathing session and review recent practice.",
  },
  {
    to: "/cycle",
    title: "Cycle tracking",
    description: "Review cycle phases and record period dates.",
  },
  {
    to: "/data-quality",
    title: "Data quality",
    description:
      "Review coverage gaps, source overlap, sync freshness, unusual observations, and manual entries.",
  },
] as const;

export function MorePage() {
  return (
    <PageLayout title="More" subtitle="Account, wellbeing, and tracking tools">
      <nav aria-label="More destinations">
        <ul className="grid gap-3 sm:grid-cols-2">
          {destinations.map((destination) => (
            <li key={destination.to}>
              <Link
                to={destination.to}
                className="group flex h-full items-center justify-between gap-4 rounded-lg border border-border bg-surface px-4 py-4 transition-colors hover:border-accent/50 hover:bg-accent/5"
              >
                <span>
                  <span className="block text-sm font-semibold text-foreground">
                    {destination.title}
                  </span>
                  <span className="mt-1 block text-sm leading-6 text-muted">
                    {destination.description}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className="shrink-0 text-lg text-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-accent"
                >
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </PageLayout>
  );
}
